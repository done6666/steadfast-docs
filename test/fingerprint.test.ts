import assert from "node:assert/strict";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { FileIndex } from "../src/core/fingerprint.js";
import { tempDir, write } from "./helpers.js";

test("fingerprints change when governed content changes", () => {
  const root = tempDir();
  write(root, "src/a.ts", "export const a = 1;\n");
  write(root, "src/b.ts", "export const b = 1;\n");

  const first = new FileIndex(root);
  const before = first.fingerprint(["src/**"]);
  assert.match(before, /^h1:[0-9a-f]{64}$/);

  write(root, "src/a.ts", "export const a = 2;\n");
  const after = new FileIndex(root).fingerprint(["src/**"]);
  assert.notEqual(before, after);
});

test("unrelated globs produce independent fingerprints", () => {
  const root = tempDir();
  write(root, "src/a.ts", "a");
  write(root, "lib/b.ts", "b");

  const index = new FileIndex(root);
  assert.notEqual(index.fingerprint(["src/**"]), index.fingerprint(["lib/**"]));
  assert.equal(index.fingerprint(["src/a.ts"]), new FileIndex(root).fingerprint(["src/a.ts"]));
});

test("governance files never affect their own fingerprint", () => {
  const root = tempDir();
  write(root, ".steadfast/decisions/ADR-0001.yaml", "id: ADR-0001\n");
  write(root, "src/a.ts", "a");

  const before = new FileIndex(root).fingerprint([".steadfast/**"]);
  write(root, ".steadfast/decisions/ADR-0001.yaml", "id: ADR-0001\nverified_by: changed\n");
  const after = new FileIndex(root).fingerprint([".steadfast/**"]);

  assert.equal(before, after);
});

test("nested dependency folders are ignored", () => {
  const root = tempDir();
  write(root, "packages/a/src/x.ts", "x");
  write(root, "packages/a/node_modules/dep/index.ts", "dep");
  write(root, "packages/a/dist/bundle.ts", "bundle");

  const index = new FileIndex(root);
  assert.deepEqual(index.matching(["**/*.ts"]), ["packages/a/src/x.ts"]);
});

test("large files are hashed by content, not size", () => {
  const root = tempDir();
  const first = "a".repeat(1_100_000);
  const second = "b".repeat(1_100_000);
  write(root, "src/big.txt", first);

  const before = new FileIndex(root).fingerprint(["src/big.txt"]);
  write(root, "src/big.txt", second);
  const after = new FileIndex(root).fingerprint(["src/big.txt"]);

  assert.notEqual(before, after);
});

test("external symlinks are not followed", () => {
  const root = tempDir();
  const outside = tempDir();
  write(outside, "secret.txt", "one");
  write(root, "src/a.ts", "a");
  symlinkSync(join(outside, "secret.txt"), join(root, "src", "link.txt"));

  const before = new FileIndex(root).fingerprint(["src/**"]);
  write(outside, "secret.txt", "two");
  const after = new FileIndex(root).fingerprint(["src/**"]);

  assert.equal(before, after);
});

test("matching returns sorted repo-relative paths", () => {
  const root = tempDir();
  write(root, "src/z.ts", "z");
  write(root, "src/a.ts", "a");
  write(root, "src/nested/b.ts", "b");

  const index = new FileIndex(root);
  assert.deepEqual(index.matching(["src/*.ts"]), ["src/a.ts", "src/z.ts"]);
  assert.deepEqual(index.matching(["src/**"]), ["src/a.ts", "src/nested/b.ts", "src/z.ts"]);
});
