import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";
import { parseArgs } from "node:util";
import { parse, stringify } from "yaml";
import { gitRoot } from "../core/git.js";
import { normalizePath } from "../core/glob.js";
import { insideRoot } from "../core/paths.js";
import { estimateTokens } from "../core/tokens.js";
import { validateConfig } from "../core/validate.js";
import { paint, write, writeError } from "../output.js";
import { resolveExistingRoot } from "./shared.js";

const TEXT = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"]);
const BINARY = new Set([".pdf", ".png", ".jpg", ".jpeg", ".svg", ".gif", ".webp"]);
const NEVER = new Set(["README.md", "AGENTS.md", "LICENSE", "LICENSE.md"]);

interface Plan {
  input: string;
  absolute: string;
  glob: string;
  files: string[];
  tokens: number;
}

function documentFiles(absolute: string, isDirectory: boolean): string[] {
  if (!isDirectory) return [absolute];
  return readdirSync(absolute, { recursive: true })
    .filter((name): name is string => typeof name === "string")
    .map((name) => join(absolute, name))
    .filter((path) => lstatSync(path).isFile());
}

function planPath(root: string, value: string): Plan | string {
  const input = normalizePath(value).replace(/\/+$/, "");
  if (input.length === 0) return "empty path";
  if (input === ".steadfast" || input.startsWith(".steadfast/")) {
    return "refusing to retire .steadfast";
  }
  if (NEVER.has(input)) return `refusing to retire ${input}`;

  const absolute = join(root, input);
  if (!existsSync(absolute)) return `does not exist: ${input}`;
  if (!insideRoot(root, absolute)) return `resolves outside the project: ${input}`;
  if (lstatSync(absolute).isSymbolicLink()) return `refusing to follow a symlink: ${input}`;

  const stat = statSync(absolute);
  const files = documentFiles(absolute, stat.isDirectory());

  for (const file of files) {
    if (lstatSync(file).isSymbolicLink()) {
      return `refusing to follow a symlink: ${file.slice(root.length + 1)}`;
    }
    const extension = extname(file).toLowerCase();
    if (!TEXT.has(extension) && !BINARY.has(extension)) {
      return `refusing to retire a non-documentation file: ${file.slice(root.length + 1)}`;
    }
  }

  const tokens = files
    .filter((file) => TEXT.has(extname(file).toLowerCase()))
    .reduce((sum, file) => sum + estimateTokens(readFileSync(file, "utf8")), 0);

  return {
    input,
    absolute,
    glob: stat.isDirectory() ? `${input}/**` : input,
    files: files.map((file) => file),
    tokens,
  };
}

function runGitLiteral(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" },
    });
  } catch {
    return undefined;
  }
}

type StageResult = {
  status: "staged" | "skipped" | "failed";
  deletions: number;
};

/**
 * A retired tracked document stays in the git index until its deletion is
 * staged, so `check` would still see it. Stage the deletion and the config
 * update together; outside git there is nothing to stage.
 */
function stageRetirement(
  root: string,
  paths: string[],
  configPath: string,
): StageResult {
  if (gitRoot(root) === undefined) return { status: "skipped", deletions: 0 };

  // Stage only tracked deletions. Untracked or ignored docs need no index
  // entry, and passing them to git add would fail the whole invocation.
  const deletedRaw = runGitLiteral(root, ["ls-files", "--deleted", "-z", "--", ...paths]);
  if (deletedRaw === undefined) return { status: "failed", deletions: 0 };
  const deleted = deletedRaw.split("\0").filter(Boolean);
  if (deleted.length > 0 && runGitLiteral(root, ["add", "-A", "--", ...deleted]) === undefined) {
    return { status: "failed", deletions: deleted.length };
  }

  return runGitLiteral(root, ["add", "-A", "--", configPath]) === undefined
    ? { status: "failed", deletions: deleted.length }
    : { status: "staged", deletions: deleted.length };
}

export async function retireCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      apply: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    write("steadfast retire <path...> [--apply]");
    write("");
    write("  Moves legacy documentation out of the working tree.");
    write("  Dry-run by default. --apply deletes the files and records");
    write("  the globs in .steadfast/config.yaml as retired_docs, so check");
    write("  fails if they reappear. Git history is the archive.");
    write("  In a git worktree, --apply also stages the deletion and config.");
    return 0;
  }

  if (positionals.length === 0) {
    writeError("error: pass at least one documentation path");
    return 2;
  }

  const root = resolveExistingRoot(values.root);
  if (root === undefined) {
    writeError("error: not a steadfast project (no .steadfast directory); run: steadfast init");
    return 2;
  }

  const plans: Plan[] = [];
  for (const value of positionals) {
    const result = planPath(root, value);
    if (typeof result === "string") {
      writeError(`error: ${result}`);
      return 2;
    }
    plans.push(result);
  }

  const totalFiles = plans.reduce((sum, plan) => sum + plan.files.length, 0);
  const totalTokens = plans.reduce((sum, plan) => sum + plan.tokens, 0);

  for (const plan of plans) {
    write(
      `${plan.glob} | ${plan.files.length} files | ~${plan.tokens} tokens`,
    );
    for (const file of plan.files.slice(0, 10)) {
      write(`  ${file.slice(root.length + 1)}`);
    }
    if (plan.files.length > 10) write(`  ... +${plan.files.length - 10}`);
  }

  if (!values.apply) {
    write("");
    write(`${paint.yellow("dry run")} ${totalFiles} files, ~${totalTokens} tokens`);
    write("run again with --apply to delete and record retired_docs");
    return 0;
  }

  const configPath = join(root, ".steadfast", "config.yaml");
  const parsedConfig = validateConfig(
    parse(readFileSync(configPath, "utf8")),
    ".steadfast/config.yaml",
  );
  if (parsedConfig.issues.some((issue) => issue.severity === "error")) {
    for (const issue of parsedConfig.issues) {
      writeError(`error: ${issue.code}: ${issue.message}`);
    }
    return 2;
  }
  const config = parsedConfig.value;
  const retired = [...new Set([...config.retired_docs, ...plans.map((plan) => plan.glob)])];
  writeFileSync(
    configPath,
    stringify({ ...config, retired_docs: retired }, { lineWidth: 0 }),
  );

  for (const plan of plans) {
    rmSync(plan.absolute, { recursive: true, force: true });
  }

  const staging = stageRetirement(
    root,
    plans.map((plan) => plan.input),
    ".steadfast/config.yaml",
  );

  write("");
  write(`${paint.green("retired")} ${totalFiles} files, ~${totalTokens} tokens`);
  write("  .steadfast/config.yaml");
  if (staging.status === "staged") {
    write(
      staging.deletions > 0
        ? "  staged: documentation deletion and .steadfast/config.yaml"
        : "  staged: .steadfast/config.yaml",
    );
  } else if (staging.status === "failed") {
    writeError(
      "warning: could not stage the retirement; run git add -A -- <paths> .steadfast/config.yaml",
    );
  }
  write(`  recover: git log -- ${plans.map((plan) => plan.input).join(" ")}`);
  write("next: steadfast check --strict");
  return staging.status === "failed" ? 1 : 0;
}
