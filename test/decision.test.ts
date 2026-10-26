import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { cli, tempDir, write } from "./helpers.js";

function project() {
  const root = tempDir();
  write(root, "src/a.ts", "export const a = 1;\n");
  write(root, "test/a.test.ts", "export {};\n");
  assert.equal(cli(["init"], root).status, 0);
  return root;
}

test("new is machine-readable and explain resolves a supersede chain", () => {
  const root = project();
  const created = cli(
    [
      "new",
      "--json",
      "--scope",
      "global",
      "--topic",
      "rule",
      "--decision",
      "Rule one.",
      "--applies-to",
      "src/**",
      "--status",
      "active",
      "--enforced-by",
      "test/a.test.ts",
    ],
    root,
  );
  assert.equal(created.status, 0, created.stderr);
  const first = JSON.parse(created.stdout) as { id: string; ok: boolean; path: string };
  assert.equal(first.ok, true);
  assert.equal(first.id, "ADR-0001");

  const explained = JSON.parse(
    cli(["explain", first.id, "--json"], root).stdout,
  ) as { resolved: string; topic: string };
  assert.equal(explained.resolved, "active");
  assert.equal(explained.topic, "rule");

  const superseded = cli(
    [
      "supersede",
      first.id,
      "--json",
      "--decision",
      "Rule two.",
      "--why",
      "The first rule was too broad.",
      "--enforced-by",
      "test/a.test.ts",
    ],
    root,
  );
  assert.equal(superseded.status, 0, superseded.stderr);
  const second = JSON.parse(superseded.stdout) as { id: string; supersedes: string[] };
  assert.deepEqual(second.supersedes, [first.id]);

  const old = JSON.parse(cli(["explain", first.id, "--json"], root).stdout) as {
    resolved: string;
    superseded_by: string;
  };
  assert.equal(old.resolved, "superseded");
  assert.equal(old.superseded_by, second.id);
  assert.equal(cli(["check", "--strict"], root).status, 0);
});

test("supersede inherits enforcement, guards and rejected alternatives", () => {
  const root = project();
  assert.equal(
    cli(
      [
        "new",
        "--scope",
        "global",
        "--topic",
        "rule",
        "--decision",
        "Rule one.",
        "--applies-to",
        "src/**",
        "--status",
        "active",
        "--enforced-by",
        "test/a.test.ts",
      ],
      root,
    ).status,
    0,
  );

  const path = join(root, ".steadfast", "decisions", "ADR-0001.yaml");
  const text = readFileSync(path, "utf8");
  writeFileSync(
    path,
    text.replace(
      "enforced_by:",
      'rejected:\n  - A softer rule.\nguards:\n  - deny: "src/** fetch"\n    instead: src/a.ts\nenforced_by:',
    ),
  );
  assert.equal(cli(["verify", "ADR-0001", "--assume"], root).status, 0);

  const superseded = cli(
    ["supersede", "ADR-0001", "--decision", "Rule two."],
    root,
  );
  assert.equal(superseded.status, 0, superseded.stderr);

  const next = parse(
    readFileSync(join(root, ".steadfast", "decisions", "ADR-0002.yaml"), "utf8"),
  ) as {
    enforced_by?: string;
    guards?: Array<{ deny: string; instead: string }>;
    rejected?: string[];
  };
  assert.equal(next.enforced_by, "test/a.test.ts");
  assert.deepEqual(next.guards, [{ deny: "src/** fetch", instead: "src/a.ts" }]);
  assert.deepEqual(next.rejected, ["A softer rule."]);
  assert.equal(cli(["check", "--strict"], root).status, 0);
});

test("new --supersedes inherits enforcement from a single predecessor", () => {
  const root = project();
  assert.equal(
    cli(
      [
        "new",
        "--scope",
        "global",
        "--topic",
        "rule",
        "--decision",
        "Rule one.",
        "--applies-to",
        "src/**",
        "--status",
        "active",
        "--enforced-by",
        "test/a.test.ts",
      ],
      root,
    ).status,
    0,
  );

  const successor = cli(
    [
      "new",
      "--scope",
      "global",
      "--topic",
      "rule",
      "--supersedes",
      "ADR-0001",
      "--status",
      "active",
      "--decision",
      "Rule two.",
    ],
    root,
  );
  assert.equal(successor.status, 0, successor.stderr);

  const next = parse(
    readFileSync(join(root, ".steadfast", "decisions", "ADR-0002.yaml"), "utf8"),
  ) as { enforced_by?: string; applies_to?: string[] };
  assert.equal(next.enforced_by, "test/a.test.ts");
  assert.deepEqual(next.applies_to, ["src/**"]);
  assert.equal(cli(["check", "--strict"], root).status, 0);
});

test("supersede refuses a non-active record", () => {
  const root = project();
  assert.equal(
    cli(
      [
        "new",
        "--scope",
        "global",
        "--topic",
        "rule",
        "--decision",
        "Rule one.",
        "--applies-to",
        "src/**",
        "--status",
        "active",
        "--enforced-by",
        "test/a.test.ts",
      ],
      root,
    ).status,
    0,
  );
  assert.equal(
    cli(["supersede", "ADR-0001", "--decision", "Rule two."], root).status,
    0,
  );
  const third = cli(
    ["supersede", "ADR-0001", "--decision", "Rule three."],
    root,
  );
  assert.equal(third.status, 2);
  assert.match(third.stderr, /only active records can be superseded/);
});
