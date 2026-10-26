import assert from "node:assert/strict";
import test from "node:test";
import { matchGlob, specificity } from "../src/core/glob.js";

test("** crosses directory boundaries", () => {
  assert.equal(matchGlob("a.ts", "**/*.ts"), true);
  assert.equal(matchGlob("src/a.ts", "**/*.ts"), true);
  assert.equal(matchGlob("src/x/y.ts", "**/*.ts"), true);
  assert.equal(matchGlob("src/x/y.js", "**/*.ts"), false);
});

test("trailing ** matches everything below", () => {
  assert.equal(matchGlob("src/a.ts", "src/**"), true);
  assert.equal(matchGlob("src/a/b.ts", "src/**"), true);
  assert.equal(matchGlob("src", "src/**"), false);
  assert.equal(matchGlob("lib/a.ts", "src/**"), false);
});

test("deep patterns stay linear", () => {
  const path = `${"a/".repeat(400)}z.ts`;
  const glob = `${"**/".repeat(50)}never.ts`;
  assert.equal(matchGlob(path, glob), false);
});

test("* stays inside one segment", () => {
  assert.equal(matchGlob("src/a.ts", "src/*.ts"), true);
  assert.equal(matchGlob("src/a/b.ts", "src/*.ts"), false);
  assert.equal(matchGlob("src/a.tsx", "src/*.ts"), false);
});

test("? matches exactly one non-slash character", () => {
  assert.equal(matchGlob("a1.ts", "a?.ts"), true);
  assert.equal(matchGlob("a12.ts", "a?.ts"), false);
  assert.equal(matchGlob("a/b.ts", "a?b.ts"), false);
});

test("leading ./ is normalized", () => {
  assert.equal(matchGlob("./src/a.ts", "src/**"), true);
});

test("regex metacharacters are escaped", () => {
  assert.equal(matchGlob("src/a+b.ts", "src/a+b.ts"), true);
  assert.equal(matchGlob("src/aab.ts", "src/a+b.ts"), false);
});

test("specificity ranks literal content above wildcards", () => {
  assert.equal(specificity("src/billing/**"), 10);
  assert.equal(specificity("**/*.ts"), 1);
  assert.equal(specificity("package.json"), 1012);
  assert.ok(specificity("**/charge.ts") > specificity("src/**"));
  assert.ok(specificity("src/billing/charge.ts") > specificity("src/billing/**"));
});
