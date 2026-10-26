import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { canonicalSkillPath } from "../src/core/skill.js";
import { estimateTokens } from "../src/core/tokens.js";
import { cli, tempDir, write } from "./helpers.js";

const OPENCODE_TARGET = ".opencode/skills/steadfast/SKILL.md";

test("the canonical skill respects its budget", () => {
  const text = readFileSync(canonicalSkillPath(), "utf8");
  const lines = text.split("\n").length;
  const tokens = estimateTokens(text);

  assert.ok(lines <= 150, `skill has ${lines} lines`);
  assert.ok(tokens <= 1200, `skill is ${tokens} tokens`);
  assert.match(text, /^---\nname: steadfast\ndescription: .+\n---/);
  assert.match(text, /execute tests/);
  assert.match(text, /omitted/);
  for (const command of ["context", "check", "new", "verify"]) {
    assert.ok(text.includes(`steadfast-docs ${command}`), `missing ${command}`);
  }
  assert.equal(text.includes("npx steadfast "), false);
});

test("skill without a subcommand prints help and writes nothing", () => {
  const root = tempDir();
  const result = cli(["skill"], root);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /steadfast skill install/);
  assert.equal(existsSync(join(root, ".opencode")), false);
});

test("skill install writes a verified copy", () => {
  const root = tempDir();
  const installed = cli(["skill", "install", "--platform", "opencode"], root);
  assert.equal(installed.status, 0, installed.stderr);

  const target = join(root, OPENCODE_TARGET);
  assert.equal(readFileSync(target, "utf8"), readFileSync(canonicalSkillPath(), "utf8"));

  const check = cli(["skill", "install", "--platform", "opencode", "--check"], root);
  assert.equal(check.status, 0, check.stderr);

  writeFileSync(target, "tampered");
  const stale = cli(["skill", "install", "--platform", "opencode", "--check"], root);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /stale/);

  const refused = cli(["skill", "install", "--platform", "opencode"], root);
  assert.equal(refused.status, 2);

  const forced = cli(["skill", "install", "--platform", "opencode", "--force"], root);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(readFileSync(target, "utf8"), readFileSync(canonicalSkillPath(), "utf8"));
});

test("skill install refuses a dangling symlink", () => {
  const root = tempDir();
  const outside = join(tempDir(), "pwned.md");
  const target = join(root, OPENCODE_TARGET);
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(outside, target);

  const result = cli(["skill", "install", "--platform", "opencode"], root);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /symlink/);
  assert.equal(existsSync(outside), false);
});

test("check reports an installed skill that drifted", () => {
  const root = tempDir();
  write(root, "src/a.ts", "a");
  assert.equal(cli(["init"], root).status, 0);

  const target = join(root, OPENCODE_TARGET);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "tampered");

  const result = cli(["check"], root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /skill\/stale/);
});
