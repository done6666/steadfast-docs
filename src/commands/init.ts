import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { gitRoot } from "../core/git.js";
import { DEFAULT_CONFIG } from "../core/validate.js";
import { paint, write, writeError } from "../output.js";

const BEGIN = "<!-- steadfast:begin -->";
const END = "<!-- steadfast:end -->";

const AGENTS_BLOCK = `${BEGIN}
## Project memory

Before editing, run \`npx steadfast-docs context --for <paths>\` and use only that output for context.
Records are not reading material: do not load other records, superseded or retired ones.
After \`steadfast new\`, fill the record you just created. Never edit an active record; supersede it.

Before committing, run \`npx steadfast-docs check\`.
${END}
`;

const MANIFEST_STACKS: Record<string, string> = {
  "package.json": "node",
  "tsconfig.json": "typescript",
  "pyproject.toml": "python",
  "requirements.txt": "python",
  "go.mod": "go",
  "Cargo.toml": "rust",
  Gemfile: "ruby",
  "pom.xml": "java",
  "build.gradle": "java",
  "composer.json": "php",
};

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git", ".next"]);

function ensureAgentsContract(root: string): "written" | "replaced" | "malformed" {
  const path = join(root, "AGENTS.md");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";

  const begins = existing.split(BEGIN).length - 1;
  const ends = existing.split(END).length - 1;
  const beginIndex = existing.indexOf(BEGIN);
  const endIndex = existing.indexOf(END);

  if (begins === 1 && ends === 1 && beginIndex !== -1 && endIndex > beginIndex) {
    const next = `${existing.slice(0, beginIndex)}${AGENTS_BLOCK.trimEnd()}${existing.slice(endIndex + END.length)}`;
    writeFileSync(path, `${next.trimEnd()}\n`);
    return "replaced";
  }

  if (begins === 0 && ends === 0) {
    const prefix = existing.trimEnd().length > 0 ? `${existing.trimEnd()}\n\n` : "";
    writeFileSync(path, `${prefix}${AGENTS_BLOCK}`);
    return "written";
  }

  return "malformed";
}

function scan(root: string): Record<string, unknown> {
  const stacks = new Set<string>();
  const scopes = new Set<string>();
  const manifests: string[] = [];

  const inspect = (relativePath: string): void => {
    const name = relativePath.split("/").pop() ?? relativePath;
    const stack = MANIFEST_STACKS[name];
    if (stack === undefined) return;
    stacks.add(stack);
    manifests.push(relativePath);
  };

  for (const rel of Object.keys(MANIFEST_STACKS)) {
    if (existsSync(join(root, rel))) inspect(rel);
  }

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    for (const rel of Object.keys(MANIFEST_STACKS)) {
      if (existsSync(join(root, entry.name, rel))) {
        inspect(`${entry.name}/${rel}`);
        scopes.add(entry.name);
      }
    }
  }

  for (const group of ["packages", "apps"]) {
    const dir = join(root, group);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const rel of Object.keys(MANIFEST_STACKS)) {
        if (existsSync(join(dir, entry.name, rel))) {
          inspect(`${group}/${entry.name}/${rel}`);
          scopes.add(`${group}/${entry.name}`);
        }
      }
    }
  }

  const tests = ["test", "tests", "spec", "__tests__"].filter((name) =>
    existsSync(join(root, name)),
  );

  return {
    root,
    stacks: [...stacks].sort(),
    manifests: manifests.sort(),
    scopes: [...scopes].sort(),
    tests,
    budgets: DEFAULT_CONFIG.budgets,
    next: [
      "Write 8-25 invariants to .steadfast/invariants.yaml. One sentence each; if it needs a paragraph it is a decision.",
      "Append one decision per non-obvious choice. Give each an enforced_by test or command.",
      "Rules without enforced_by are advisory and expire.",
      "Run: steadfast check --strict",
    ],
  };
}

export async function initCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string" },
      adopt: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  if (values.help) {
    write("steadfast init [--dir <path>] [--adopt]");
    write("");
    write("  Creates .steadfast/ and the AGENTS.md contract.");
    write("  Defaults to the git root; use --dir to target a subdirectory.");
    write("  --adopt  prints a machine-readable discovery brief for the agent");
    return 0;
  }

  const explicit = values.dir !== undefined;
  const start = resolve(values.dir ?? process.cwd());
  const root = explicit ? start : (gitRoot(start) ?? start);

  const base = join(root, ".steadfast");
  mkdirSync(join(base, "decisions"), { recursive: true });

  const configPath = join(base, "config.yaml");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, stringify(DEFAULT_CONFIG, { lineWidth: 0 }));
  }

  const invariantsPath = join(base, "invariants.yaml");
  if (!existsSync(invariantsPath)) {
    writeFileSync(invariantsPath, "# Max 25 rules. One sentence each.\n# Changing an invariant requires a decision record.\n[]\n");
  }

  const contract = ensureAgentsContract(root);
  if (contract === "malformed") {
    writeError("warning: AGENTS.md has malformed steadfast markers; left untouched");
  }

  if (values.adopt) {
    write(JSON.stringify(scan(root), null, 2));
    return 0;
  }

  write(`${paint.green("initialized")} ${root}`);
  write("  .steadfast/config.yaml");
  write("  .steadfast/invariants.yaml");
  write("  .steadfast/decisions/");
  write("  AGENTS.md");
  write("");
  write("next: npx steadfast-docs new --scope global --topic <topic> --decision \"<rule>\" --status active");
  return 0;
}
