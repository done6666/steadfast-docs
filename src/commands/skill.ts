import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { insideRoot, safeFile } from "../core/paths.js";
import { readCanonicalSkill, skillTarget } from "../core/skill.js";
import { findProjectRoot } from "../core/store.js";
import { paint, write, writeError } from "../output.js";

function printHelp(): void {
  write("steadfast skill install [--platform opencode|claude] [--global] [--check] [--force]");
  write("");
  write("  Installs the canonical agent loop from skills/steadfast/SKILL.md.");
  write("  --platform  opencode (default) or claude");
  write("  --global    install into the user directory instead of the project");
  write("  --check     report missing or stale copies without writing");
  write("  --force     overwrite a different existing copy");
}

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function deepestExisting(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

export async function skillCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      platform: { type: "string", default: "opencode" },
      global: { type: "boolean", default: false },
      root: { type: "string" },
      check: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help || positionals.length === 0) {
    printHelp();
    return 0;
  }

  if (positionals.length > 1 || positionals[0] !== "install") {
    writeError("error: usage: steadfast skill install [options]");
    return 2;
  }

  const platform = values.platform;
  if (platform !== "opencode" && platform !== "claude") {
    writeError(`error: unsupported platform "${platform}"; use opencode or claude`);
    return 2;
  }

  if (values.global && values.root !== undefined) {
    writeError("error: use either --global or --root, not both");
    return 2;
  }

  const base = values.global
    ? homedir()
    : values.root !== undefined
      ? resolve(values.root)
      : (findProjectRoot(process.cwd()) ?? process.cwd());

  if (!existsSync(base)) {
    writeError(`error: target root does not exist: ${base}`);
    return 2;
  }

  const target = skillTarget(platform, base, values.global);
  const canonical = readCanonicalSkill();

  if (values.check) {
    if (!lexists(target.path)) {
      writeError(`missing ${target.path}`);
      writeError(`fix: steadfast skill install --platform ${platform}${values.global ? " --global" : ""}`);
      return 1;
    }
    if (lstatSync(target.path).isSymbolicLink()) {
      writeError(`error: ${target.path} is a symlink; refusing to read through it`);
      return 1;
    }
    if (!values.global) {
      const safe = safeFile(base, relative(base, target.path));
      if (safe === undefined) {
        writeError(`error: ${target.path} resolves outside the project`);
        return 1;
      }
      if (readFileSync(safe, "utf8") !== canonical) {
        writeError(`stale ${target.path}`);
        writeError(`fix: steadfast skill install --platform ${platform} --force`);
        return 1;
      }
    } else if (readFileSync(target.path, "utf8") !== canonical) {
      writeError(`stale ${target.path}`);
      writeError(`fix: steadfast skill install --platform ${platform} --force --global`);
      return 1;
    }

    write(`${paint.green("ok")} ${target.path}`);
    return 0;
  }

  if (lexists(target.path)) {
    if (lstatSync(target.path).isSymbolicLink()) {
      writeError(`error: ${target.path} is a symlink; refusing to write through it`);
      return 2;
    }
    if (!values.force) {
      if (readFileSync(target.path, "utf8") === canonical) {
        write(`unchanged ${target.path}`);
        return 0;
      }
      writeError(`error: ${target.path} already exists and differs`);
      writeError("  use --force to overwrite, or --check to report drift");
      return 2;
    }
  }

  const parent = dirname(target.path);
  if (!values.global) {
    const anchor = deepestExisting(parent);
    if (!insideRoot(base, anchor)) {
      writeError(`error: ${anchor} resolves outside the project`);
      return 2;
    }
  }

  mkdirSync(parent, { recursive: true });

  if (!values.global && !insideRoot(base, parent)) {
    writeError(`error: ${parent} resolves outside the project`);
    return 2;
  }

  if (lexists(target.path)) unlinkSync(target.path);

  const temporary = `${target.path}.${process.pid}.tmp`;
  writeFileSync(temporary, canonical, { flag: "wx" });
  renameSync(temporary, target.path);
  write(`${paint.green("installed")} ${target.path}`);
  return 0;
}
