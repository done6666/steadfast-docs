import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { cli, tempDir, write } from "./helpers.js";

function project(): string {
  const root = tempDir();
  write(root, "src/a.ts", "export const a = 1;\n");
  write(root, "test/a.test.ts", "export {};\n");
  assert.equal(cli(["init"], root).status, 0);
  return root;
}

function roadmap(root: string, body: string): void {
  write(root, ".steadfast/roadmap.yaml", body);
}

const VALID = `version: 1
updated: ${new Date().toISOString().slice(0, 10)}
steps:
  - id: STEP-001
    goal: Add the cleanup job
    why: Inactive users keep rows forever.
    paths: [src/**]
    acceptance: run test/a.test.ts
    status: current
  - id: STEP-002
    goal: Add config bounds
    why: Unbounded values exhaust the pool.
    paths: [src/a.ts]
    acceptance: run test/a.test.ts
    status: todo
`;

test("init scaffolds an empty roadmap", () => {
  const root = project();
  assert.ok(existsSync(join(root, ".steadfast", "roadmap.yaml")));
  const brief = cli(["brief"], root);
  assert.equal(brief.status, 0, brief.stderr);
  assert.match(brief.stdout, /roadmap: 0 todo/);
});

test("brief prints the current step, next step and memory stats", () => {
  const root = project();
  roadmap(root, VALID);

  const result = cli(["brief"], root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# steadfast brief v1/);
  assert.match(result.stdout, /current:/);
  assert.match(result.stdout, /STEP-001 Add the cleanup job/);
  assert.match(result.stdout, /next:/);
  assert.match(result.stdout, /STEP-002 Add config bounds/);
  assert.match(result.stdout, /memory: 0 active/);
});

test("brief --json is machine-readable", () => {
  const root = project();
  roadmap(root, VALID);

  const result = cli(["brief", "--json"], root);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout) as {
    ok: boolean;
    current: string;
    next: string[];
    tokens: number;
    budget: number;
  };
  assert.equal(body.ok, true);
  assert.equal(body.current, "STEP-001");
  assert.deepEqual(body.next, ["STEP-002"]);
  assert.ok(body.tokens <= body.budget);
});

test("done steps require evidence", () => {
  const root = project();
  roadmap(
    root,
    VALID.replace("status: current", "status: done"),
  );

  const result = cli(["check"], root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /roadmap\/evidence/);
});

test("only one step can be current", () => {
  const root = project();
  roadmap(
    root,
    VALID.replace("status: todo", "status: current"),
  );

  const result = cli(["check"], root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /roadmap\/current/);
});

test("a current step cannot be blocked by unfinished work", () => {
  const root = project();
  roadmap(
    root,
    `version: 1
updated: ${new Date().toISOString().slice(0, 10)}
steps:
  - id: STEP-001
    goal: First
    why: Because.
    paths: [src/a.ts]
    acceptance: test
    status: todo
  - id: STEP-002
    goal: Second
    why: Because.
    paths: [src/a.ts]
    acceptance: test
    status: current
    blocked_by: STEP-001
`,
  );

  const result = cli(["check"], root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /roadmap\/current-blocked/);
});

test("roadmap decisions must exist", () => {
  const root = project();
  roadmap(
    root,
    VALID.replace("status: current", "status: current\n    decisions: [ADR-9999]"),
  );

  const result = cli(["check"], root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /roadmap\/decision-missing/);
});

test("brief fails on an invalid roadmap instead of guessing", () => {
  const root = project();
  roadmap(root, "version: 1\nsteps:\n  - id: STEP-001\n");

  const result = cli(["brief"], root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /schema\/missing-field/);
});

test("brief --budget can only lower the configured cap", () => {
  const root = project();
  roadmap(root, VALID);

  const result = cli(["brief", "--budget", "1000"], root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /budget: \d+\/300/);

  const lowered = cli(["brief", "--budget", "120"], root);
  assert.equal(lowered.status, 0, lowered.stderr);
  assert.match(lowered.stdout, /budget: \d+\/120/);
  assert.equal(cli(["brief", "--budget", "10"], root).status, 2);
  assert.equal(cli(["brief", "--budget", "120abc"], root).status, 2);
});

test("brief stays inside its budget with a long current step", () => {
  const root = project();
  roadmap(
    root,
    `version: 1
updated: ${new Date().toISOString().slice(0, 10)}
steps:
  - id: STEP-001
    goal: ${"x".repeat(160)}
    why: ${"y".repeat(200)}
    paths: [src/**]
    acceptance: ${"z".repeat(200)}
    status: current
`,
  );

  const result = cli(["brief", "--budget", "120", "--json"], root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const body = JSON.parse(result.stdout) as { tokens: number; budget: number };
  assert.ok(body.tokens <= body.budget, `${body.tokens} > ${body.budget}`);
});

test("brief refuses an invalid decision graph", () => {
  const root = project();
  const created = cli(
    [
      "new",
      "--scope",
      "global",
      "--topic",
      "same-topic",
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
  const raw = readFileSync(join(root, ".steadfast/decisions/ADR-0001.yaml"), "utf8");
  write(root, ".steadfast/decisions/ADR-0002.yaml", raw.replace("id: ADR-0001", "id: ADR-0002"));

  const result = cli(["brief"], root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /graph\/duplicate-topic/);
});

test("roadmap does not leak into context", () => {
  const root = project();
  roadmap(
    root,
    VALID.replace("Add the cleanup job", "CONTEXT-SENTINEL"),
  );

  const result = cli(["context", "--for", "src/a.ts"], root);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /CONTEXT-SENTINEL/);
});

test("a stale current step warns and then fails", () => {
  const root = project();
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
  roadmap(root, VALID.replace(/^updated: .*$/m, `updated: ${old}`));

  const result = cli(["check"], root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /roadmap\/stale/);
});

test("whitespace evidence is not evidence", () => {
  const root = project();
  roadmap(
    root,
    VALID.replace("status: current", "status: done\n    evidence: \"   \""),
  );

  const result = cli(["check"], root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /roadmap\/evidence/);
});

test("blocked steps require a reason", () => {
  const root = project();
  roadmap(root, VALID.replace("status: todo", "status: blocked"));

  const result = cli(["check"], root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /roadmap\/blocked-by/);
});

test("brief and check work without a roadmap file", () => {
  const root = project();
  rmSync(join(root, ".steadfast", "roadmap.yaml"));

  const brief = cli(["brief"], root);
  assert.equal(brief.status, 0, brief.stderr);
  assert.match(brief.stdout, /roadmap: none/);
  assert.equal(cli(["check", "--strict"], root).status, 0);
});

test("roadmap must stay inside the project", () => {
  const root = project();
  const outside = join(tempDir(), "roadmap.yaml");
  writeFileSync(outside, VALID);
  rmSync(join(root, ".steadfast", "roadmap.yaml"));
  symlinkSync(outside, join(root, ".steadfast", "roadmap.yaml"));

  const check = cli(["check"], root);
  assert.equal(check.status, 1);
  assert.match(check.stdout, /fs\/outside-root/);

  const brief = cli(["brief"], root);
  assert.equal(brief.status, 1);
  assert.match(brief.stderr, /fs\/outside-root/);
});

test("doctor reports the current roadmap step", () => {
  const root = project();
  roadmap(root, VALID);

  const result = cli(["doctor", "--json"], root);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as {
    checks: Array<{ id: string; status: string; message: string }>;
  };
  const check = report.checks.find((item) => item.id === "roadmap");
  assert.equal(check?.status, "ok");
  assert.match(check?.message ?? "", /STEP-001/);
});
