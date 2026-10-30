import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { gitCommonDir, gitPath, gitRoot } from "../core/git.js";
import { relativeInside } from "../core/paths.js";
import { isObject, toPosix } from "../util.js";
import { paint, write, writeError } from "../output.js";
import { writeConfig } from "./mcp.js";
import { resolveExistingRoot } from "./shared.js";

const BEGIN = "# steadfast:begin";
const END = "# steadfast:end";
const ORIGINAL = "steadfast-original";

export function hookPathFor(root: string): string | undefined {
  if (gitRoot(root) === undefined) return undefined;
  return gitPath(root, "hooks/pre-commit");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function realPath(path: string): string | undefined {
  let current = path;
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return undefined;
    suffix.unshift(basename(current));
    current = parent;
  }
  try {
    return join(realpathSync(current), ...suffix);
  } catch {
    return undefined;
  }
}

function hookBlock(root: string, git: string, hookPath: string): string {
  const prefix = toPosix(relative(git, root));
  const cd = prefix.length === 0 ? "" : `  cd -- ${shellQuote(prefix)} || exit 1\n`;
  const original = shellQuote(basename(`${hookPath}.${ORIGINAL}`));
  return `${BEGIN}
(
  __steadfast_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  if [ -x "$__steadfast_dir"/${original} ]; then
    "$__steadfast_dir"/${original} "$@" || exit $?
  fi
${cd}  run_steadfast() {
    if [ -x "./node_modules/.bin/steadfast" ]; then
      ./node_modules/.bin/steadfast "$@"
    elif [ -f "./dist/src/cli.js" ]; then
      node ./dist/src/cli.js "$@"
    else
      npx -y steadfast-docs "$@"
    fi
  }
  if git rev-parse --verify HEAD >/dev/null 2>&1; then
    run_steadfast check --strict --staged --diff HEAD || exit 1
  else
    run_steadfast check --strict --staged || exit 1
  fi
) || exit 1
${END}
`;
}

export function sessionSettingsPath(root: string): string {
  return join(root, ".claude", "settings.json");
}

function briefCommandFor(root: string): string {
  if (existsSync(join(root, "node_modules", ".bin", "steadfast"))) {
    return "./node_modules/.bin/steadfast brief";
  }
  const running = process.argv[1] === undefined ? undefined : realPath(process.argv[1]);
  const rootReal = realPath(root);
  const local =
    running === undefined || rootReal === undefined ? undefined : relativeInside(rootReal, running);
  if (local !== undefined && !local.startsWith("node_modules/")) return `node ${local} brief`;
  return "npx -y steadfast-docs brief";
}

function isSessionEntry(entry: unknown): boolean {
  if (!isObject(entry) || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(
    (hook) =>
      isObject(hook) &&
      typeof hook.command === "string" &&
      /steadfast/.test(hook.command) &&
      / brief\b/.test(hook.command),
  );
}

function readSettings(path: string): Record<string, unknown> | string {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isObject(parsed) ? parsed : `error: ${path} must hold a JSON object`;
  } catch (error) {
    return `error: ${path} is not plain JSON (${(error as Error).message})`;
  }
}

function sessionEntries(settings: Record<string, unknown>): unknown[] {
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  return Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
}

export function sessionHookInstalled(root: string): boolean {
  const settings = readSettings(sessionSettingsPath(root));
  return typeof settings !== "string" && sessionEntries(settings).some(isSessionEntry);
}

function installSession(root: string): number {
  const path = sessionSettingsPath(root);
  const settings = readSettings(path);
  if (typeof settings === "string") {
    writeError(settings);
    return 2;
  }
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  hooks.SessionStart = [
    ...sessionEntries(settings).filter((entry) => !isSessionEntry(entry)),
    { hooks: [{ type: "command", command: briefCommandFor(root) }] },
  ];
  settings.hooks = hooks;
  const written = writeConfig(root, path, settings);
  if (written.startsWith("error:")) {
    writeError(written);
    return 2;
  }
  write(`${paint.green("installed")} SessionStart brief in ${written}`);
  write("every new, resumed, cleared or compacted Claude Code session starts with the brief");
  return 0;
}

function removeSession(root: string): number {
  const path = sessionSettingsPath(root);
  const settings = readSettings(path);
  if (typeof settings === "string") {
    writeError(settings);
    return 2;
  }
  const entries = sessionEntries(settings);
  if (!entries.some(isSessionEntry)) {
    write("no SessionStart brief found; left untouched");
    return 0;
  }
  const hooks = settings.hooks as Record<string, unknown>;
  const rest = entries.filter((entry) => !isSessionEntry(entry));
  if (rest.length > 0) hooks.SessionStart = rest;
  else delete hooks.SessionStart;
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  const written = writeConfig(root, path, settings);
  if (written.startsWith("error:")) {
    writeError(written);
    return 2;
  }
  write(`removed SessionStart brief from ${written}`);
  return 0;
}

function writeHook(hookPath: string, content: string): void {
  mkdirSync(dirname(hookPath), { recursive: true });
  writeFileSync(hookPath, `${content.trimEnd()}\n`);
  chmodSync(hookPath, 0o755);
}

function install(root: string, git: string, hookPath: string): number {
  const existing = existsSync(hookPath) ? readFileSync(hookPath, "utf8") : "";
  const hasBegin = existing.includes(BEGIN);
  const hasEnd = existing.includes(END);
  if (hasBegin !== hasEnd) {
    writeError(`error: ${hookPath} has a malformed steadfast block; fix it by hand`);
    return 2;
  }

  const originalPath = `${hookPath}.${ORIGINAL}`;
  const block = hookBlock(root, git, hookPath);
  let chained = false;

  if (hasBegin) {
    const start = existing.indexOf(BEGIN);
    const end = existing.indexOf(END) + END.length;
    writeHook(hookPath, `${existing.slice(0, start)}${block.trimEnd()}${existing.slice(end)}`);
  } else {
    if (existing.trim().length > 0) {
      if (existsSync(originalPath)) {
        writeError(
          `error: ${originalPath} already exists; restore or remove it before installing`,
        );
        return 2;
      }
      renameSync(hookPath, originalPath);
      chmodSync(originalPath, 0o755);
      chained = true;
    }

    try {
      writeHook(hookPath, `#!/bin/sh\n\n${block}`);
    } catch (error) {
      if (chained) renameSync(originalPath, hookPath);
      throw error;
    }
  }

  write(`${paint.green("installed")} ${hookPath}`);
  if (chained) write(`chained the existing hook as ${basename(originalPath)}`);
  write(
    "the hook runs check --strict before every commit; bypass with --no-verify only in an emergency",
  );
  return 0;
}

function remove(hookPath: string): number {
  if (!existsSync(hookPath)) {
    write("not installed");
    return 0;
  }
  const existing = readFileSync(hookPath, "utf8");
  if (!existing.includes(BEGIN) || !existing.includes(END)) {
    write("no steadfast block found; left untouched");
    return 0;
  }

  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END) + END.length;
  const next = `${existing.slice(0, start)}${existing.slice(end)}`.trim();
  const extra = next.length > 0 && next !== "#!/bin/sh";

  const originalPath = `${hookPath}.${ORIGINAL}`;
  if (existsSync(originalPath)) {
    if (extra) {
      writeError(
        `error: ${hookPath} has content outside the steadfast block; refusing to overwrite it`,
      );
      writeError("  remove the extra content, then run: steadfast hook remove");
      return 2;
    }
    unlinkSync(hookPath);
    renameSync(originalPath, hookPath);
    chmodSync(hookPath, 0o755);
    write("removed the wrapper and restored the existing hook");
    return 0;
  }

  if (!extra) {
    unlinkSync(hookPath);
    write("removed hook");
    return 0;
  }
  writeHook(hookPath, next);
  write("removed steadfast block; the rest of the hook is preserved");
  return 0;
}

export async function hookCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      check: { type: "boolean", default: false },
      platform: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help || positionals.length === 0) {
    write("steadfast hook install|remove [--platform claude] [--check] [--root <path>]");
    write("");
    write("  install     add a managed check --strict block to the git pre-commit hook");
    write("  remove      remove only the steadfast block, restoring any chained hook");
    write("  --platform  claude: also run brief at every session start (.claude/settings.json)");
    write("  --check     report whether the hooks are installed");
    return 0;
  }

  const action = positionals[0];
  if (action !== "install" && action !== "remove") {
    writeError("error: usage: steadfast hook install|remove");
    return 2;
  }
  if (values.platform === "opencode") {
    writeError("error: opencode has no session-start context hook; AGENTS.md tells the agent to run brief");
    return 2;
  }
  if (values.platform !== undefined && values.platform !== "claude") {
    writeError(`error: unsupported platform "${values.platform}"; use claude`);
    return 2;
  }
  const session = values.platform === "claude";

  const root = resolveExistingRoot(values.root);
  if (root === undefined) {
    writeError("error: not a steadfast project (no .steadfast directory); run: steadfast init");
    return 2;
  }
  const git = gitRoot(root);
  if (git === undefined) {
    writeError("error: not a git work tree");
    return 2;
  }
  const hookPath = hookPathFor(root);
  if (hookPath === undefined) {
    writeError("error: cannot resolve the git hooks directory");
    return 2;
  }

  const common = gitCommonDir(root);
  const realHook = realPath(hookPath);
  let gitReal: string | undefined;
  let commonReal: string | undefined;
  try {
    gitReal = realpathSync(git);
    commonReal = common === undefined ? undefined : realpathSync(common);
  } catch {
    gitReal = undefined;
  }
  const local =
    realHook !== undefined &&
    gitReal !== undefined &&
    relativeInside(gitReal, realHook) !== undefined;
  const inCommon =
    realHook !== undefined &&
    commonReal !== undefined &&
    relativeInside(commonReal, realHook) !== undefined;
  if (!local && !inCommon) {
    writeError(
      `error: the git hooks directory is shared outside this repository: ${hookPath}`,
    );
    writeError(
      "  a project-specific hook would run in every repository; chain `steadfast check` from the shared hook instead",
    );
    return 2;
  }

  if (values.check) {
    let status = 0;
    const installed = existsSync(hookPath) && readFileSync(hookPath, "utf8").includes(BEGIN);
    if (installed) {
      write(`${paint.green("ok")} ${hookPath}`);
    } else {
      writeError("missing: pre-commit hook");
      writeError("fix: steadfast hook install");
      status = 1;
    }
    if (session) {
      if (sessionHookInstalled(root)) {
        write(`${paint.green("ok")} SessionStart brief in ${sessionSettingsPath(root)}`);
      } else {
        writeError("missing: SessionStart brief");
        writeError("fix: steadfast hook install --platform claude");
        status = 1;
      }
    }
    return status;
  }

  if (action === "remove") {
    const status = remove(hookPath);
    return status !== 0 || !session ? status : removeSession(root);
  }

  if (session) {
    const settings = readSettings(sessionSettingsPath(root));
    if (typeof settings === "string") {
      writeError(settings);
      return 2;
    }
  }
  const status = install(root, git, hookPath);
  return status !== 0 || !session ? status : installSession(root);
}
