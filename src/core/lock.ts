import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const WAIT_MS = 50;
const ATTEMPTS = 600;
const ORPHAN_MS = 5_000;
const OWNER = "owner.json";

interface Owner {
  pid: number;
  token: string;
}

function sleep(ms: number): void {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(cell, 0, 0, ms);
}

function readOwner(path: string): Owner | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(path, OWNER), "utf8")) as Partial<Owner>;
    if (typeof parsed.pid === "number" && typeof parsed.token === "string") {
      return { pid: parsed.pid, token: parsed.token };
    }
  } catch {
    // Missing or partially written owner file.
  }
  return undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Atomic reclaim: exactly one contender wins the rename. */
function reclaim(path: string): boolean {
  const stale = `${path}.stale-${randomUUID()}`;
  try {
    renameSync(path, stale);
  } catch {
    return false;
  }
  rmSync(stale, { recursive: true, force: true });
  return true;
}

/**
 * Cross-process lock for the decision directory. The owner file carries the
 * holder pid and a token, so a crashed process is reclaimed immediately and a
 * stale holder can never delete a newer holder's lock.
 */
export function acquireLock(path: string): () => void {
  const token = randomUUID();

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    try {
      mkdirSync(path);
      try {
        writeFileSync(join(path, OWNER), JSON.stringify({ pid: process.pid, token }), {
          flag: "wx",
        });
      } catch (error) {
        rmSync(path, { recursive: true, force: true });
        throw error;
      }

      return () => {
        const owner = readOwner(path);
        if (owner?.token !== token) return;
        rmSync(path, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      const owner = readOwner(path);
      if (owner === undefined) {
        try {
          const stat = statSync(path);
          if (Date.now() - stat.mtimeMs > ORPHAN_MS) reclaim(path);
        } catch {
          // Released between EEXIST and stat; retry.
        }
      } else if (!isAlive(owner.pid)) {
        reclaim(path);
      }

      sleep(WAIT_MS);
    }
  }

  const owner = readOwner(path);
  const holder = owner === undefined ? "unknown holder" : `pid ${owner.pid}`;
  throw new Error(
    `could not acquire lock (${holder}): ${path}; delete it only if no steadfast new is running`,
  );
}
