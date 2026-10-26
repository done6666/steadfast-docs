import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const CLI = join(process.cwd(), "dist", "src", "cli.js");

export function tempDir(prefix = "steadfast-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function write(root: string, relativePath: string, content: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function cli(args: string[], cwd: string): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
