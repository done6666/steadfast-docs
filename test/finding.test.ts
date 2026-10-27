import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { cli, tempDir, write } from "./helpers.js";

function project(): string {
  const root = tempDir();
  write(root, "src/features/wallhack/esp.ts", "export const esp = 1;\n");
  write(root, "src/other.ts", "export const other = 1;\n");
  write(root, "scripts/re/health.py", "print('offset')\n");
  write(root, "test/health.test.ts", "export {};\n");
  assert.equal(cli(["init"], root).status, 0);
  return root;
}

function finding(root: string, extra: string[] = []): ReturnType<typeof cli> {
  return cli(
    [
      "finding",
      "new",
      "--scope",
      "client",
      "--topic",
      "health-offset",
      "--target",
      "game-client@1.2.3",
      "--claim",
      "Health is a float at 0x1A2B3C.",
      "--evidence",
      "scripts/re/health.py",
      "--confidence",
      "high",
      "--applies-to",
      "src/features/wallhack/**",
      ...extra,
    ],
    root,
  );
}

test("finding new records an observation and explain reads it", () => {
  const root = project();
  const created = finding(root);
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /FIND-0001/);

  const explained = cli(["finding", "explain", "FIND-0001", "--json"], root);
  assert.equal(explained.status, 0, explained.stderr);
  const body = JSON.parse(explained.stdout) as { id: string; target: string; resolved: string };
  assert.equal(body.id, "FIND-0001");
  assert.equal(body.target, "game-client@1.2.3");
  assert.equal(body.resolved, "active");
  assert.equal(cli(["check", "--strict"], root).status, 0);
});

test("findings enter only the matching pack", () => {
  const root = project();
  assert.equal(finding(root).status, 0);

  const hit = cli(["context", "--for", "src/features/wallhack/esp.ts"], root);
  assert.equal(hit.status, 0, hit.stderr);
  assert.match(hit.stdout, /FIND-0001/);
  assert.match(hit.stdout, /Health is a float/);
  const strict = cli(["context", "--strict", "--for", "src/features/wallhack/esp.ts"], root);
  assert.equal(strict.status, 0, strict.stderr);

  const miss = cli(["context", "--for", "src/other.ts"], root);
  assert.equal(miss.status, 0, miss.stderr);
  assert.doesNotMatch(miss.stdout, /FIND-0001/);
});

test("retract appends a retracted successor and surfaces it as do_not_revisit", () => {
  const root = project();
  assert.equal(finding(root).status, 0);
  const retracted = cli(
    ["finding", "retract", "FIND-0001", "--why", "the field is a double"],
    root,
  );
  assert.equal(retracted.status, 0, retracted.stderr);
  assert.match(retracted.stdout, /FIND-0002/);

  const check = cli(["check", "--strict"], root);
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /findings 0 active, 1 retracted/);

  const pack = cli(["context", "--for", "src/features/wallhack/esp.ts"], root);
  assert.equal(pack.status, 0, pack.stderr);
  assert.match(pack.stdout, /do_not_revisit/);
  assert.match(pack.stdout, /FIND-0002/);
  assert.match(pack.stdout, /the field is a double/);
});

test("retire removes the finding from the pack", () => {
  const root = project();
  assert.equal(finding(root).status, 0);
  const retired = cli(
    [
      "finding",
      "retire",
      "FIND-0001",
      "--evidence",
      "test/health.test.ts",
    ],
    root,
  );
  assert.equal(retired.status, 0, retired.stderr);

  const pack = cli(["context", "--for", "src/features/wallhack/esp.ts"], root);
  assert.equal(pack.status, 0, pack.stderr);
  assert.doesNotMatch(pack.stdout, /FIND-0001/);
  assert.doesNotMatch(pack.stdout, /Health is a float/);
});

test("a duplicate active finding is refused", () => {
  const root = project();
  assert.equal(finding(root).status, 0);
  const duplicate = finding(root);
  assert.equal(duplicate.status, 2);
  assert.match(duplicate.stderr, /already covers/);
});

test("missing evidence fails check", () => {
  const root = project();
  assert.equal(finding(root).status, 0);
  rmSync(join(root, "scripts/re/health.py"));

  const check = cli(["check"], root);
  assert.equal(check.status, 1);
  assert.match(check.stdout, /path\/evidence-missing/);
});

test("a stale finding warns and fails strict mode", () => {
  const root = project();
  assert.equal(finding(root, ["--observed-at", "2020-01-01"]).status, 0);

  const check = cli(["check"], root);
  assert.equal(check.status, 0);
  assert.match(check.stdout, /finding\/stale/);

  assert.equal(cli(["check", "--strict"], root).status, 1);
});

test("superseding a stale finding clears the stale warning", () => {
  const root = project();
  assert.equal(finding(root, ["--observed-at", "2020-01-01"]).status, 0);
  const superseded = cli(
    [
      "finding",
      "supersede",
      "FIND-0001",
      "--claim",
      "Health is a float at 0x1A2B3C.",
      "--observed-at",
      new Date().toISOString().slice(0, 10),
    ],
    root,
  );
  assert.equal(superseded.status, 0, superseded.stderr);
  assert.equal(cli(["check", "--strict"], root).status, 0);
});

test("supersede needs a new observation", () => {
  const root = project();
  assert.equal(finding(root).status, 0);
  const result = cli(["finding", "supersede", "FIND-0001"], root);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /new content/);
});

test("retracted findings do not require their old evidence", () => {
  const root = project();
  assert.equal(finding(root).status, 0);
  assert.equal(
    cli(["finding", "retract", "FIND-0001", "--why", "false"], root).status,
    0,
  );
  rmSync(join(root, "scripts/re/health.py"));
  assert.equal(cli(["check", "--strict"], root).status, 0);
});

test("a supersede cycle is rejected", () => {
  const root = project();
  assert.equal(finding(root).status, 0);
  const first = readFileSync(join(root, ".steadfast/findings/FIND-0001.yaml"), "utf8");
  write(
    root,
    ".steadfast/findings/FIND-0001.yaml",
    `${first}supersedes: [FIND-0002]\n`,
  );
  write(
    root,
    ".steadfast/findings/FIND-0002.yaml",
    `${first.replace("id: FIND-0001", "id: FIND-0002")}supersedes: [FIND-0001]\n`,
  );

  const result = cli(["check"], root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /graph\/cycle/);
});

test("a finding whose applies_to matches nothing warns", () => {
  const root = project();
  const result = cli(
    [
      "finding",
      "new",
      "--scope",
      "client",
      "--topic",
      "typo",
      "--target",
      "game-client@1.2.3",
      "--claim",
      "A fact.",
      "--evidence",
      "scripts/re/health.py",
      "--confidence",
      "high",
      "--applies-to",
      "src/featurs/**",
    ],
    root,
  );
  assert.equal(result.status, 0, result.stderr);

  const check = cli(["check"], root);
  assert.equal(check.status, 0);
  assert.match(check.stdout, /path\/no-match/);
});

test("edited findings are rejected by check --diff", () => {
  const root = project();
  const git = (args: string[]): void => {
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: root,
      stdio: "ignore",
    });
  };
  git(["init"]);
  git(["add", "-A"]);
  git(["commit", "-m", "base"]);

  assert.equal(finding(root).status, 0);
  git(["add", "-A"]);
  git(["commit", "-m", "finding"]);

  const path = join(root, ".steadfast/findings/FIND-0001.yaml");
  writeFileSync(path, readFileSync(path, "utf8").replace("Health is a float", "Health is an int"));

  const result = cli(["check", "--diff", "HEAD"], root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /history\/edited-finding/);
});

test("remembered evidence is required at write time", () => {
  const root = project();
  const result = finding(root, ["--evidence", "scripts/re/missing.py"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /does not resolve to a file/);
});
