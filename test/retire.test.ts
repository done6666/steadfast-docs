import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

function gitProject() {
  const root = project();
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  };
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "base"]);
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

test("retire --apply stages the deletion and config in git", () => {
  const root = gitProject();
  const result = cli(["retire", "legacy-docs", "--apply"], root);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /staged: documentation deletion/);

  const staged = execFileSync("git", ["diff", "--cached", "--name-status"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(staged, /^D\s+legacy-docs\/architecture\.md$/m);
  assert.match(staged, /^M\s+\.steadfast\/config\.yaml$/m);

  const unstaged = execFileSync("git", ["diff", "--name-only"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  assert.equal(unstaged, "");

  assert.equal(cli(["check", "--strict"], root).status, 0);
  assert.equal(cli(["check", "--strict", "--staged"], root).status, 0);
  assert.equal(cli(["check", "--strict", "--staged", "--diff", "HEAD"], root).status, 0);
});

test("retire stages config when the docs were never tracked", () => {
  const root = gitProject();
  write(root, "loose-docs/notes.md", "# loose\n");

  const result = cli(["retire", "loose-docs", "--apply"], root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /staged: \.steadfast\/config\.yaml/);

  const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(staged, /^\.steadfast\/config\.yaml$/m);
  assert.doesNotMatch(staged, /loose-docs/);
  assert.equal(cli(["check", "--strict", "--staged", "--diff", "HEAD"], root).status, 0);
});

test("retire --apply --no-stage leaves the changes unstaged", () => {
  const root = gitProject();

  const invalid = cli(["retire", "legacy-docs", "--no-stage"], root);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /requires --apply/);

  const result = cli(["retire", "legacy-docs", "--apply", "--no-stage"], root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /not staged: --no-stage/);

  const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  assert.equal(staged, "");

  const unstaged = execFileSync("git", ["diff", "--name-only"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(unstaged, /legacy-docs\/architecture\.md/);
  assert.match(unstaged, /\.steadfast\/config\.yaml/);

  const check = cli(["check", "--strict"], root);
  assert.equal(check.status, 1);
  assert.match(check.stdout, /docs\/retired-present/);
});

test("a real config change remains decision debt", () => {
  const root = gitProject();
  const configPath = join(root, ".steadfast", "config.yaml");
  const text = readFileSync(configPath, "utf8").replace(
    "context_tokens: 1500",
    "context_tokens: 900",
  );
  write(root, ".steadfast/config.yaml", text);

  const result = cli(["check", "--strict", "--diff", "HEAD"], root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /debt\/undocumented-change/);
});

test("removing a retired glob is decision debt", () => {
  const root = gitProject();
  assert.equal(cli(["retire", "legacy-docs", "--apply"], root).status, 0);
  execFileSync("git", ["commit", "-q", "-m", "retire"], { cwd: root });

  execFileSync("git", ["checkout", "HEAD~1", "--", "legacy-docs"], { cwd: root });
  const configPath = join(root, ".steadfast", "config.yaml");
  const text = readFileSync(configPath, "utf8").replace(
    /retired_docs:\n  - legacy-docs\/\*\*/,
    "retired_docs: []",
  );
  write(root, ".steadfast/config.yaml", text);

  const result = cli(["check", "--strict", "--diff", "HEAD"], root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /debt\/undocumented-change/);
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
