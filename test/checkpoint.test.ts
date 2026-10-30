import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { cli, tempDir, write } from "./helpers.js";

const TODAY = new Date().toISOString().slice(0, 10);

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function project(): string {
  const root = tempDir();
  write(root, "src/a.ts", "export const a = 1;\n");
  write(root, "docs/notes.txt", "notes\n");
  write(root, "test/a.test.ts", "export {};\n");
  assert.equal(cli(["init"], root).status, 0);
  return root;
}

function repo(): string {
  const root = project();
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "test"]);
  return root;
}

function commitAll(root: string, message: string): void {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
}

function roadmap(root: string, checkpoint: string, status = "current"): void {
  write(
    root,
    ".steadfast/roadmap.yaml",
    `version: 1
updated: ${TODAY}
steps:
  - id: STEP-001
    goal: Add the cleanup job
    why: Inactive users keep rows forever.
    paths: [src]
    acceptance: run test/a.test.ts
    status: ${status}
${status === "done" ? "    evidence: test/a.test.ts\n" : ""}${checkpoint}`,
  );
}

const CHECKPOINT = `    checkpoint:
      next: Wire the job into the scheduler
      done: ["Migration and handler"]
      open: ["Retention window is a guess"]
`;

test("brief shows where the last session stopped", () => {
  const root = project();
  roadmap(root, CHECKPOINT);

  const result = cli(["brief"], root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /checkpoint:\n {2}next: Wire the job into the scheduler\n {2}done: Migration and handler\n {2}open: Retention window is a guess/);

  const json = JSON.parse(cli(["brief", "--json"], root).stdout) as {
    checkpoint: { next: string; done: string[] };
  };
  assert.equal(json.checkpoint.next, "Wire the job into the scheduler");
  assert.deepEqual(json.checkpoint.done, ["Migration and handler"]);
});

test("brief asks for a checkpoint when the current step has none", () => {
  const root = project();
  roadmap(root, "");

  const result = cli(["brief"], root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /checkpoint: none \(write checkpoint\.next/);
});

test("brief keeps the checkpoint when the budget forces the fallback", () => {
  const root = project();
  roadmap(root, CHECKPOINT);

  const result = cli(["brief", "--budget", "120"], root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /next: Wire the job/);
});

test("checkpoints are bounded and need a next action", () => {
  const cases: Array<[string, RegExp]> = [
    ["    checkpoint:\n      done: [\"a\"]\n", /missing required field "next"/],
    ["    checkpoint:\n      next: x\n      later: y\n", /unknown field "checkpoint\.later"/],
    ["    checkpoint:\n      next: x\n      done: [a, b, c, d]\n", /"done" has 4 items; limit is 3/],
    [`    checkpoint:\n      next: ${"x".repeat(161)}\n`, /"next" is 161 chars; limit is 160/],
    ["    checkpoint: resume later\n", /"checkpoint" must be a mapping/],
  ];
  for (const [checkpoint, expected] of cases) {
    const root = project();
    roadmap(root, checkpoint);
    const result = cli(["check"], root);
    assert.equal(result.status, 1, checkpoint);
    assert.match(result.stdout + result.stderr, expected);
  }
});

test("done steps carry no checkpoint", () => {
  const root = project();
  roadmap(root, CHECKPOINT, "done");

  const result = cli(["check"], root);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /roadmap\/checkpoint-closed/);
});

test("check --diff flags step work that left the checkpoint behind", () => {
  const root = repo();
  roadmap(root, CHECKPOINT);
  commitAll(root, "base");

  write(root, "src/a.ts", "export const a = 2;\n");
  const stale = cli(["check", "--strict", "--diff", "HEAD"], root);
  assert.equal(stale.status, 1);
  assert.match(stale.stdout + stale.stderr, /roadmap\/checkpoint-stale/);
  assert.match(stale.stdout + stale.stderr, /src\/a\.ts/);

  roadmap(root, CHECKPOINT.replace("Wire the job into the scheduler", "Add the retention test"));
  const fresh = cli(["check", "--strict", "--diff", "HEAD"], root);
  assert.doesNotMatch(fresh.stdout + fresh.stderr, /checkpoint-stale/);
});

test("check --diff requires a checkpoint once step work starts", () => {
  const root = repo();
  roadmap(root, "");
  commitAll(root, "base");

  write(root, "src/a.ts", "export const a = 2;\n");
  const result = cli(["check", "--strict", "--diff", "HEAD"], root);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /roadmap\/checkpoint-stale/);
});

test("check --diff ignores changes outside the current step", () => {
  const root = repo();
  roadmap(root, CHECKPOINT);
  commitAll(root, "base");

  write(root, "docs/notes.txt", "more notes\n");
  const result = cli(["check", "--strict", "--diff", "HEAD"], root);
  assert.doesNotMatch(result.stdout + result.stderr, /checkpoint-stale/);
});
