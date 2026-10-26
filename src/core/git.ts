import { execFileSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { toPosix, uniq } from "../util.js";

export interface Change {
  status: string;
  path: string;
  from?: string;
}

export function runGit(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

export function tryGit(root: string, args: string[]): string | undefined {
  try {
    return runGit(root, args);
  } catch {
    return undefined;
  }
}

export function gitRoot(start: string): string | undefined {
  return tryGit(start, ["rev-parse", "--show-toplevel"]);
}

/**
 * Resolves a git-internal path such as `hooks/pre-commit`. Respects
 * `core.hooksPath`, linked worktrees and submodules; the result may be
 * relative to `root`.
 */
export function gitPath(root: string, path: string): string | undefined {
  const top = gitRoot(root);
  if (top === undefined) return undefined;
  const value = tryGit(top, ["rev-parse", "--git-path", path]);
  return value === undefined || value.length === 0 ? undefined : resolve(top, value);
}

export function gitCommonDir(root: string): string | undefined {
  const top = gitRoot(root);
  if (top === undefined) return undefined;
  const value = tryGit(top, ["rev-parse", "--git-common-dir"]);
  return value === undefined || value.length === 0 ? undefined : resolve(top, value);
}

export function isValidRef(root: string, ref: string): boolean {
  return tryGit(root, ["rev-parse", "--verify", `${ref}^{commit}`]) !== undefined;
}

export function mergeBase(root: string, ref: string): string | undefined {
  const top = gitRoot(root);
  if (top === undefined) return undefined;
  const value = tryGit(top, ["merge-base", ref, "HEAD"]);
  return value !== undefined && value.length > 0 ? value : undefined;
}

function toRootRelative(top: string, root: string, path: string): string | undefined {
  const absolute = join(top, path);
  const value = toPosix(relative(root, absolute));
  if (value.startsWith("../") || value === "..") return undefined;
  return value;
}

function pathArgFor(top: string, root: string): string {
  const prefix = toPosix(relative(top, root));
  return prefix.length === 0 ? "." : prefix;
}

/**
 * Changes since the merge base of `ref` and HEAD, not since the tip. This keeps
 * a PR from inheriting unrelated changes that landed on the base branch.
 */
export function changedEntries(root: string, ref: string): Change[] {
  const top = gitRoot(root);
  if (top === undefined) return [];

  const base = mergeBase(root, ref) ?? ref;
  const pathArg = pathArgFor(top, root);

  const output = execFileSync(
    "git",
    ["diff", "--name-status", "-z", "--find-renames", base, "--", pathArg],
    {
      cwd: top,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    },
  );

  const parts = output.split("\0").filter((part) => part.length > 0);
  const entries: Change[] = [];

  let index = 0;
  while (index < parts.length) {
    const status = parts[index++];
    if (status === undefined) break;

    if (status.startsWith("R") || status.startsWith("C")) {
      const fromRaw = parts[index++];
      const pathRaw = parts[index++];
      if (fromRaw === undefined || pathRaw === undefined) break;
      const from = toRootRelative(top, root, fromRaw);
      const path = toRootRelative(top, root, pathRaw);
      if (from !== undefined && path !== undefined) {
        entries.push({ status: status[0]!, from, path });
      }
      continue;
    }

    const pathRaw = parts[index++];
    if (pathRaw === undefined) break;
    const path = toRootRelative(top, root, pathRaw);
    if (path !== undefined) entries.push({ status: status[0]!, path });
  }

  const untracked = runGit(top, ["ls-files", "--others", "--exclude-standard", "--", pathArg]);
  for (const raw of untracked.split("\n")) {
    const value = raw.trim();
    if (value.length === 0) continue;
    const path = toRootRelative(top, root, value);
    if (path !== undefined) entries.push({ status: "A", path });
  }

  return entries;
}

export function changedFiles(root: string, ref: string): string[] {
  return uniq(
    changedEntries(root, ref).flatMap((entry) => [
      entry.path,
      ...(entry.from === undefined ? [] : [entry.from]),
    ]),
  ).sort();
}

/**
 * Files whose working-tree content differs from the index. `check --staged`
 * uses this to ensure a pre-commit run validates what will actually commit.
 */
export function unstagedFiles(root: string): string[] {
  const top = gitRoot(root);
  if (top === undefined) return [];

  const pathArg = pathArgFor(top, root);
  const output = execFileSync(
    "git",
    ["diff", "--name-only", "-z", "--no-renames", "--", pathArg],
    {
      cwd: top,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    },
  );

  return output
    .split("\0")
    .filter((path) => path.length > 0)
    .map((path) => toRootRelative(top, root, path))
    .filter((path): path is string => path !== undefined);
}

export function untrackedFiles(root: string): string[] {
  const top = gitRoot(root);
  if (top === undefined) return [];

  const pathArg = pathArgFor(top, root);
  const output = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z", "--", pathArg],
    {
      cwd: top,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    },
  );

  return output
    .split("\0")
    .filter((path) => path.length > 0)
    .map((path) => toRootRelative(top, root, path))
    .filter((path): path is string => path !== undefined);
}

export function headSha(root: string): string | undefined {
  return tryGit(root, ["rev-parse", "HEAD"]);
}

export function fileAtRef(root: string, ref: string, path: string): string | undefined {
  const top = gitRoot(root);
  if (top === undefined) return undefined;

  const base = mergeBase(root, ref) ?? ref;
  const full = toPosix(relative(top, join(root, path)));
  if (full.startsWith("../") || full === "..") return undefined;

  try {
    return execFileSync("git", ["show", `${base}:${full}`], {
      cwd: top,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}
