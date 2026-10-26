import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { cli, tempDir, write } from "./helpers.js";

function project() {
  const root = tempDir();
  write(root, "legacy-docs/architecture.md", "# Architecture\n\nsome prose\n");
  write(root, "legacy-docs/adr/0001.md", "# ADR\n\nmore prose\n");
  write(root, "src/a.ts", "export const a = 1;\n");
  write(root, "README.md", "# demo\n");
  assert.equal(cli(["init"], root).status, 0);
  return root;
}

test("retire is a dry run by default", () => {
  const root = project();
  const result = cli(["retire", "legacy-docs"], root);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dry run/);
  assert.ok(existsSync(join(root, "legacy-docs", "architecture.md")));
  assert.match(
    readFileSync(join(root, ".steadfast", "config.yaml"), "utf8"),
    /retired_docs: \[\]/,
  );
});

test("retire --apply deletes docs and records retired_docs", () => {
  const root = project();
  const result = cli(["retire", "legacy-docs", "--apply"], root);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(root, "legacy-docs")), false);

  const config = readFileSync(join(root, ".steadfast", "config.yaml"), "utf8");
  assert.match(config, /retired_docs:/);
  assert.match(config, /legacy-docs\/\*\*/);
  assert.equal(cli(["check", "--strict"], root).status, 0);
});

test("check fails when retired docs reappear", () => {
  const root = project();
  assert.equal(cli(["retire", "legacy-docs", "--apply"], root).status, 0);

  write(root, "legacy-docs/back.md", "# back\n");
  const result = cli(["check"], root);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /docs\/retired-present/);
});

test("retire refuses non-documentation files", () => {
  const root = project();
  const result = cli(["retire", "src/a.ts"], root);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /non-documentation/);
});

test("retire refuses the root README and AGENTS contracts", () => {
  const root = project();
  assert.equal(cli(["retire", "README.md"], root).status, 2);
  assert.equal(cli(["retire", "AGENTS.md"], root).status, 2);
});
