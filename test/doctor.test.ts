import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { cli, tempDir, write } from "./helpers.js";

const noAgentPath = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
};

interface DoctorCheck {
  id: string;
  status: "ok" | "warn" | "error";
  message: string;
  fix?: string;
}

interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  stats: { errors: number; warnings: number };
}

function doctor(root: string): { status: number; report: DoctorReport } {
  const home = tempDir();
  const result = cli(["doctor", "--json"], root, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
  });
  return { status: result.status, report: JSON.parse(result.stdout) as DoctorReport };
}

function statusOf(report: DoctorReport, id: string): string | undefined {
  return report.checks.find((check) => check.id === id)?.status;
}

test("doctor reports a missing agent wiring without failing the project", () => {
  const root = tempDir();
  assert.equal(cli(["init"], root).status, 0);

  const { status, report } = doctor(root);
  assert.equal(status, 0, JSON.stringify(report));
  assert.equal(report.ok, true);
  assert.equal(statusOf(report, "node"), "ok");
  assert.equal(statusOf(report, "config"), "ok");
  assert.equal(statusOf(report, "invariants"), "ok");
  assert.equal(statusOf(report, "decisions"), "ok");
  assert.equal(statusOf(report, "agents"), "ok");
  assert.equal(statusOf(report, "skill"), "warn");
  assert.equal(statusOf(report, "mcp"), "warn");
  assert.equal(statusOf(report, "check"), "ok");
  const skill = report.checks.find((check) => check.id === "skill");
  assert.match(skill?.fix ?? "", /steadfast skill install/);
});

test("doctor passes once the skill and MCP config are installed", () => {
  const root = tempDir();
  assert.equal(cli(["init"], root).status, 0);
  assert.equal(cli(["skill", "install", "--platform", "opencode"], root).status, 0);
  assert.equal(
    cli(["mcp", "install", "--platform", "opencode"], root, noAgentPath).status,
    0,
  );

  const { status, report } = doctor(root);
  assert.equal(status, 0, JSON.stringify(report));
  assert.equal(statusOf(report, "skill"), "ok");
  assert.equal(statusOf(report, "mcp"), "ok");
  assert.equal(report.stats.errors, 0);
});

test("doctor does not count superseded records as advisory", () => {
  const root = tempDir();
  write(root, "test/a.test.ts", "export {};\n");
  assert.equal(cli(["init"], root).status, 0);
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
        "--status",
        "active",
        "--enforced-by",
        "test/a.test.ts",
      ],
      root,
    ).status,
    0,
  );
  assert.equal(cli(["supersede", "ADR-0001", "--decision", "Rule two."], root).status, 0);

  const { status, report } = doctor(root);
  assert.equal(status, 0, JSON.stringify(report));
  assert.equal(statusOf(report, "advisory"), "ok");
});

test("doctor rejects a skill copy that points outside the project", () => {
  const root = tempDir();
  assert.equal(cli(["init"], root).status, 0);

  const outside = join(tempDir(), "outside-skill.md");
  writeFileSync(outside, "not the canonical skill");
  const target = join(root, ".opencode", "skills", "steadfast", "SKILL.md");
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(outside, target);

  const { status, report } = doctor(root);
  assert.equal(status, 1);
  assert.equal(statusOf(report, "skill"), "error");
  const skill = report.checks.find((check) => check.id === "skill");
  assert.match(skill?.message ?? "", /escapes the project/);
});

test("doctor fails on a stale skill copy", () => {
  const root = tempDir();
  assert.equal(cli(["init"], root).status, 0);
  assert.equal(cli(["skill", "install", "--platform", "opencode"], root).status, 0);

  writeFileSync(join(root, ".opencode", "skills", "steadfast", "SKILL.md"), "tampered");

  const { status, report } = doctor(root);
  assert.equal(status, 1);
  assert.equal(report.ok, false);
  assert.equal(statusOf(report, "skill"), "error");
  const skill = report.checks.find((check) => check.id === "skill");
  assert.match(skill?.fix ?? "", /--force/);
});
