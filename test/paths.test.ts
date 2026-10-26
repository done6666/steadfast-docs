import assert from "node:assert/strict";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { insideRoot, safeFile } from "../src/core/paths.js";
import { tempDir, write } from "./helpers.js";

test("safeFile accepts real files inside the project", () => {
  const root = tempDir();
  write(root, "src/a.ts", "a");
  assert.ok(safeFile(root, "src/a.ts") !== undefined);
  assert.equal(insideRoot(root, join(root, "src", "a.ts")), true);
});

test("safeFile rejects escapes and absolute paths", () => {
  const root = tempDir();
  write(root, "src/a.ts", "a");
  assert.equal(safeFile(root, "../a.ts"), undefined);
  assert.equal(safeFile(root, "/etc/passwd"), undefined);
  assert.equal(safeFile(root, "C:\\Windows\\win.ini"), undefined);
  assert.equal(safeFile(root, "\\\\server\\share"), undefined);
  assert.equal(safeFile(root, "."), undefined);
});

test("safeFile rejects symlinks pointing outside the project", () => {
  const root = tempDir();
  const outside = tempDir();
  write(outside, "secret.ts", "secret");
  write(root, "src/a.ts", "a");
  symlinkSync(join(outside, "secret.ts"), join(root, "src", "link.ts"));

  assert.equal(safeFile(root, "src/link.ts"), undefined);
});
