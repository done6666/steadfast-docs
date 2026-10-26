import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { Hash } from "node:crypto";
import { matchesAny } from "./glob.js";
import { insideRoot } from "./paths.js";

const IGNORED: RegExp[] = [
  /(^|\/)(node_modules|dist|build|coverage|\.git|\.next|\.cache|\.turbo)\//,
  /(^|\/)\.steadfast\//,
  /(^|\/)pre-commit\.steadfast-original\//,
];

function isIgnored(path: string): boolean {
  const normalized = path.endsWith("/") ? path : `${path}/`;
  return IGNORED.some((pattern) => pattern.test(normalized));
}

function fromGit(root: string): string[] | undefined {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        cwd: root,
        maxBuffer: 128 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return output
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((path) => path.replace(/\\/g, "/"));
  } catch {
    return undefined;
  }
}

function walk(root: string, dir = root, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    const path = relative(root, absolute).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      if (!isIgnored(path)) walk(root, absolute, out);
    } else if (entry.isFile()) {
      if (!isIgnored(path)) out.push(path);
    }
  }
  return out;
}

export function listRepoFiles(root: string): string[] {
  const files = fromGit(root) ?? walk(root);
  return files.filter((path) => !isIgnored(path)).sort();
}

function hashStream(hash: Hash, absolute: string): void {
  const descriptor = openSync(absolute, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Freshness is a content fingerprint, not a commit sha: verification can happen
 * before the commit that contains it, and rebases cannot invalidate it.
 *
 * Symlinks are never followed outside the project, and special files are not
 * opened. This keeps `check` from reading /etc/passwd or blocking on /dev/zero.
 */
export class FileIndex {
  readonly root: string;
  private readonly files: string[];
  private readonly cache = new Map<string, string>();

  constructor(root: string) {
    this.root = root;
    this.files = listRepoFiles(root);
  }

  matching(globs: readonly string[]): string[] {
    return this.files.filter((path) => matchesAny(path, globs)).sort();
  }

  fingerprint(globs: readonly string[]): string {
    const key = [...globs].sort().join("\u0000");
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const hash = createHash("sha256");
    for (const path of this.matching(globs)) {
      hash.update(path);
      hash.update("\0");
      const absolute = join(this.root, path);

      try {
        const stat = lstatSync(absolute);

        if (stat.isSymbolicLink()) {
          const target = readlinkSync(absolute);
          hash.update(`link:${target}`);
          if (insideRoot(this.root, absolute)) {
            try {
              hashStream(hash, realpathSync(absolute));
            } catch {
              hash.update("broken");
            }
          } else {
            hash.update("external");
          }
        } else if (stat.isDirectory()) {
          hash.update("dir");
        } else if (!stat.isFile()) {
          hash.update("special");
        } else {
          hashStream(hash, absolute);
        }
      } catch {
        hash.update("missing");
      }

      hash.update("\0");
    }

    const value = `h1:${hash.digest("hex")}`;
    this.cache.set(key, value);
    return value;
  }
}
