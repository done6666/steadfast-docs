import assert from "node:assert/strict";
import test from "node:test";
import { cli, tempDir, write } from "./helpers.js";

function addRule(root: string, topic: string, appliesTo: string): void {
  const result = cli(
    [
      "new",
      "--scope",
      "global",
      "--topic",
      topic,
      "--decision",
      `Rule ${topic} applies to the selected files.`,
      "--applies-to",
      appliesTo,
      "--status",
      "active",
      "--enforced-by",
      "test/a.test.ts",
    ],
    root,
  );
  assert.equal(result.status, 0, result.stderr);
}

test("a directory selector expands to the files beneath it", () => {
  const root = tempDir();
  write(root, "src/core/pack.ts", "export const pack = 1;\n");
  write(root, "test/a.test.ts", "export {};\n");
  assert.equal(cli(["init"], root).status, 0);
  addRule(root, "packs", "src/core/pack.ts");
  addRule(root, "tests", "test/**");

  const directory = cli(["context", "--for", "src/core"], root);
  assert.equal(directory.status, 0, directory.stderr);
  assert.match(directory.stdout, /ADR-0001/);
  assert.doesNotMatch(directory.stdout, /ADR-0002/);
  assert.doesNotMatch(directory.stdout, /warning: no decision matches/);

  const trailingSlash = cli(["context", "--for", "src/core/"], root);
  assert.equal(trailingSlash.status, 0, trailingSlash.stderr);
  assert.match(trailingSlash.stdout, /ADR-0001/);

  const file = cli(["context", "--for", "src/core/pack.ts"], root);
  assert.equal(file.status, 0, file.stderr);
  assert.match(file.stdout, /ADR-0001/);

  const rootSelector = cli(["context", "--for", "./"], root);
  assert.equal(rootSelector.status, 0, rootSelector.stderr);
  assert.match(rootSelector.stdout, /ADR-0001/);

  const outside = cli(["context", "--for", "../outside.ts"], root);
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /inside the project/);

  const noFiles = cli(["context", "--for", "src/nope/**"], root);
  assert.equal(noFiles.status, 0, noFiles.stderr);
  assert.match(noFiles.stdout, /selector matched no tracked files/);
});

test("a dot-prefixed exact applies_to is not dropped", () => {
  const root = tempDir();
  write(root, "src/a.ts", "export const a = 1;\n");
  write(root, "test/a.test.ts", "export {};\n");
  assert.equal(cli(["init"], root).status, 0);
  addRule(root, "dot", "./src/a.ts");

  const result = cli(["context", "--for", "src"], root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ADR-0001/);
  assert.doesNotMatch(result.stdout, /warning: no decision matches/);
});

test("a glob selector expands to the files it matches", () => {
  const root = tempDir();
  write(root, "src/core/pack.ts", "export const pack = 1;\n");
  write(root, "test/a.test.ts", "export {};\n");
  assert.equal(cli(["init"], root).status, 0);
  addRule(root, "packs", "src/core/pack.ts");
  addRule(root, "tests", "test/**");

  const result = cli(["context", "--for", "src/**"], root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ADR-0001/);
  assert.doesNotMatch(result.stdout, /ADR-0002/);
});

test("context fails instead of returning a partial pack", () => {
  const root = tempDir();
  write(root, "src/a.ts", "export const a = 1;\n");
  write(root, "test/a.test.ts", "export {};\n");
  assert.equal(cli(["init"], root).status, 0);
  for (const topic of ["one", "two", "three", "four", "five"]) {
    addRule(root, topic, "src/**");
  }

  const upward = cli(["context", "--for", "src/a.ts", "--budget", "5000"], root);
  assert.equal(upward.status, 2);
  assert.match(upward.stderr, /cannot exceed budgets\.context_tokens/);

  const partial = cli(["context", "--for", "src/a.ts", "--budget", "120"], root);
  assert.equal(partial.status, 2);
  assert.match(partial.stderr, /context pack is incomplete/);
  assert.match(partial.stderr, /need ~\d+/);
  assert.match(partial.stderr, /ask the human/);
  assert.doesNotMatch(partial.stdout, /# steadfast context/);

  const allowed = cli(
    ["context", "--for", "src/a.ts", "--budget", "120", "--allow-partial"],
    root,
  );
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /omitted: [1-9]/);
});

test("the guard budget reports how many guards are needed", () => {
  const root = tempDir();
  write(root, "src/a.ts", "export const a = 1;\n");
  assert.equal(cli(["init"], root).status, 0);
  write(
    root,
    ".steadfast/config.yaml",
    [
      "version: 1",
      "budgets:",
      "  context_tokens: 1500",
      "  decision_tokens: 160",
      "  invariants: 25",
      "  guards: 1",
      "advisory_ttl_days: 90",
      "retired_docs: []",
      "",
    ].join("\n"),
  );
  write(
    root,
    ".steadfast/decisions/ADR-0001.yaml",
    [
      "id: ADR-0001",
      "topic: guards",
      "scope: global",
      "status: active",
      "created: 2026-10-26",
      "applies_to:",
      "  - src/a.ts",
      "decision: Guarded rule.",
      "guards:",
      "  - deny: a",
      "    instead: b",
      "  - deny: c",
      "    instead: d",
      "  - deny: e",
      "    instead: f",
      `verified_by: h1:${"a".repeat(64)}`,
      "by: agent",
      "",
    ].join("\n"),
  );

  const result = cli(["context", "--for", "src/a.ts"], root);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /budgets\.guards/);
  assert.match(result.stderr, /need 3/);
});

test("an uncovered selector is visible and strict mode rejects it", () => {
  const root = tempDir();
  write(root, "src/a.ts", "export const a = 1;\n");
  assert.equal(cli(["init"], root).status, 0);

  const warning = cli(["context", "--for", "src/a.ts"], root);
  assert.equal(warning.status, 0, warning.stderr);
  assert.match(warning.stdout, /warning: no decision matches "src\/a.ts"/);

  const strict = cli(["context", "--for", "src/a.ts", "--strict"], root);
  assert.equal(strict.status, 2);
  assert.match(strict.stderr, /no decision matches "src\/a.ts"/);
});
