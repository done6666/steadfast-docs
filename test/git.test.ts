import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { changedFiles, isValidRef } from "../src/core/git.js";
import { tempDir, write } from "./helpers.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

test("changedFiles is relative to the project root inside a monorepo", () => {
  const top = tempDir();
  git(top, ["init"]);
  git(top, ["config", "user.email", "test@example.com"]);
  git(top, ["config", "user.name", "test"]);

  write(top, "sub/src/a.ts", "a\n");
  git(top, ["add", "."]);
  git(top, ["commit", "-m", "init"]);

  write(top, "sub/src/a.ts", "b\n");
  write(top, "sub/src/b.ts", "c\n");

  const root = join(top, "sub");
  assert.deepEqual(changedFiles(root, "HEAD"), ["src/a.ts", "src/b.ts"]);
  assert.equal(isValidRef(root, "HEAD"), true);
  assert.equal(isValidRef(root, "does-not-exist"), false);
});
