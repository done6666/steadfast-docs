import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { cli, tempDir, write } from "./helpers.js";

const BEGIN = "<!-- steadfast:begin -->";

test("init scaffolds once and stays idempotent", () => {
  const root = tempDir();
  write(root, "package.json", '{"name":"demo"}\n');
  write(root, "test/demo.test.ts", "export {};\n");

  const first = cli(["init"], root);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(existsSync(join(root, ".steadfast", "config.yaml")));
  assert.ok(existsSync(join(root, ".steadfast", "invariants.yaml")));
  assert.ok(existsSync(join(root, ".steadfast", "roadmap.yaml")));

  const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
  assert.equal(agents.split(BEGIN).length - 1, 1);
  assert.match(agents, /npx steadfast-docs context/);

  const second = cli(["init"], root);
  assert.equal(second.status, 0, second.stderr);
  const again = readFileSync(join(root, "AGENTS.md"), "utf8");
  assert.equal(again.split(BEGIN).length - 1, 1);
});

test("init leaves malformed AGENTS.md markers untouched", () => {
  const root = tempDir();
  const original = "intro\n<!-- steadfast:begin -->\nno end marker\n";
  write(root, "AGENTS.md", original);

  const result = cli(["init"], root);
  assert.equal(result.status, 0);
  assert.match(result.stderr, /malformed/);
  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), original);
});

test("init --adopt prints a machine-readable brief", () => {
  const root = tempDir();
  write(root, "package.json", '{"name":"demo"}\n');
  write(root, "tsconfig.json", "{}\n");

  const result = cli(["init", "--adopt"], root);
  assert.equal(result.status, 0, result.stderr);
  const brief = JSON.parse(result.stdout) as { stacks: string[]; next: string[] };
  assert.ok(brief.stacks.includes("node"));
  assert.ok(brief.stacks.includes("typescript"));
  assert.ok(brief.next.length > 0);
});

test("full lifecycle: create, stale, verify, supersede, compile", () => {
  const root = tempDir();
  write(root, "src/billing/charge.ts", "export const charge = 1;\n");
  write(root, "test/client.test.ts", "export {};\n");

  assert.equal(cli(["init"], root).status, 0);

  const created = cli(
    [
      "new",
      "--scope",
      "billing",
      "--topic",
      "http-client",
      "--decision",
      "All outbound HTTP goes through src/api.ts.",
      "--applies-to",
      "src/billing/**",
      "--status",
      "active",
      "--enforced-by",
      "test/client.test.ts",
    ],
    root,
  );
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /ADR-0001/);

  const fresh = cli(["check", "--strict"], root);
  assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);

  write(root, "src/billing/charge.ts", "export const charge = 2;\n");
  const stale = cli(["check"], root);
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /fresh\/stale/);

  const verified = cli(["verify", "ADR-0001", "--assume"], root);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(cli(["check", "--strict"], root).status, 0);

  const superseded = cli(
    [
      "new",
      "--scope",
      "billing",
      "--topic",
      "http-client",
      "--decision",
      "All outbound HTTP goes through src/api/client.ts.",
      "--applies-to",
      "src/billing/**",
      "--status",
      "active",
      "--supersedes",
      "ADR-0001",
      "--enforced-by",
      "test/client.test.ts",
    ],
    root,
  );
  assert.equal(superseded.status, 0, superseded.stderr);

  const checked = cli(["check", "--strict"], root);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /1 superseded/);

  const context = cli(["context", "--for", "src/billing/charge.ts"], root);
  assert.equal(context.status, 0, context.stderr);
  assert.match(context.stdout, /ADR-0002/);
  assert.doesNotMatch(context.stdout, /ADR-0001/);
  assert.match(context.stdout, /budget: \d+\/1500/);
});

test("rejected proposals need a reason and surface in packs", () => {
  const root = tempDir();
  write(root, "src/billing/charge.ts", "export const charge = 1;\n");
  assert.equal(cli(["init"], root).status, 0);

  const withoutReason = cli(
    [
      "new",
      "--scope",
      "billing",
      "--topic",
      "retry",
      "--decision",
      "Use p-retry.",
      "--status",
      "rejected",
    ],
    root,
  );
  assert.equal(withoutReason.status, 2);

  const withReason = cli(
    [
      "new",
      "--scope",
      "billing",
      "--topic",
      "retry",
      "--decision",
      "Use p-retry.",
      "--status",
      "rejected",
      "--why",
      "adds a dependency for twenty lines",
      "--applies-to",
      "src/billing/**",
    ],
    root,
  );
  assert.equal(withReason.status, 0, withReason.stderr);

  const context = cli(["context", "--for", "src/billing/charge.ts"], root);
  assert.equal(context.status, 0, context.stderr);
  assert.match(context.stdout, /do_not_revisit/);
  assert.match(context.stdout, /adds a dependency for twenty lines/);
});

test("context refuses to dump everything", () => {
  const root = tempDir();
  write(root, "src/a.ts", "a");
  assert.equal(cli(["init"], root).status, 0);

  const result = cli(["context"], root);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--for/);
});

test("check outside a project fails cleanly", () => {
  const root = tempDir();
  const result = cli(["check"], root);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not a steadfast project/);
});

test("check --json is machine-readable", () => {
  const root = tempDir();
  write(root, "src/a.ts", "a");
  assert.equal(cli(["init"], root).status, 0);

  const result = cli(["check", "--json"], root);
  const body = JSON.parse(result.stdout) as { ok: boolean; stats: { decisions: number } };
  assert.equal(body.ok, true);
  assert.equal(body.stats.decisions, 0);
});

test("check never executes record commands; verify requires trust", () => {
  const root = tempDir();
  write(root, "src/a.ts", "a");
  assert.equal(cli(["init"], root).status, 0);

  const created = cli(
    [
      "new",
      "--scope",
      "global",
      "--topic",
      "exec",
      "--decision",
      "A command-backed rule.",
      "--applies-to",
      "src/**",
      "--status",
      "active",
      "--enforced-by",
      "!node -e \"require('fs').writeFileSync('executed.txt','1')\"",
    ],
    root,
  );
  assert.equal(created.status, 0, created.stderr);

  const checked = cli(["check"], root);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.equal(existsSync(join(root, "executed.txt")), false);

  const denied = cli(["verify", "ADR-0001"], root);
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /--trust/);
  assert.equal(existsSync(join(root, "executed.txt")), false);

  const trusted = cli(["verify", "ADR-0001", "--trust"], root);
  assert.equal(trusted.status, 0, trusted.stderr);
  assert.equal(existsSync(join(root, "executed.txt")), true);
});

test("check --diff enforces append-only history", () => {
  const root = tempDir();
  write(root, "src/a.ts", "a");

  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  };
  git(["init"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);

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
        "Original rule.",
        "--applies-to",
        "src/**",
        "--status",
        "active",
        "--enforced-by",
        "src/a.ts",
      ],
      root,
    ).status,
    0,
  );

  git(["add", "-A"]);
  git(["commit", "-m", "init"]);

  assert.equal(cli(["verify", "ADR-0001", "--assume"], root).status, 0);
  const afterVerify = cli(["check", "--diff", "HEAD"], root);
  assert.equal(afterVerify.status, 0, afterVerify.stdout + afterVerify.stderr);

  const file = join(root, ".steadfast", "decisions", "ADR-0001.yaml");
  const edited = readFileSync(file, "utf8").replace(/^decision:.*$/m, "decision: Edited rule.");
  writeFileSync(file, edited);

  const afterEdit = cli(["check", "--diff", "HEAD"], root);
  assert.equal(afterEdit.status, 1);
  assert.match(afterEdit.stdout, /history\/edited-record/);
});

test("context fails closed when the memory is invalid", () => {
  const root = tempDir();
  write(root, "src/a.ts", "a");
  assert.equal(cli(["init"], root).status, 0);

  write(
    root,
    ".steadfast/decisions/ADR-0001.yaml",
    [
      "id: ADR-0001",
      "topic: broken",
      "scope: global",
      "status: active",
      "created: 2026-10-26",
      "applies_to:",
      "  - src/**",
      "decision: Broken rule.",
      `verified_by: h1:${"a".repeat(64)}`,
      "notes: not a real field",
    ].join("\n"),
  );

  const result = cli(["context", "--for", "src/a.ts"], root);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown field/);
});

test("check --diff rejects renames but allows draft edits", () => {
  const root = tempDir();
  write(root, "src/a.ts", "a");

  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  };
  git(["init"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);

  assert.equal(cli(["init"], root).status, 0);
  assert.equal(
    cli(
      [
        "new",
        "--scope",
        "global",
        "--topic",
        "draft",
        "--decision",
        "Draft rule.",
        "--applies-to",
        "src/**",
        "--status",
        "draft",
      ],
      root,
    ).status,
    0,
  );
  assert.equal(
    cli(
      [
        "new",
        "--scope",
        "global",
        "--topic",
        "active",
        "--decision",
        "Active rule.",
        "--applies-to",
        "src/**",
        "--status",
        "active",
        "--enforced-by",
        "src/a.ts",
      ],
      root,
    ).status,
    0,
  );

  git(["add", "-A"]);
  git(["commit", "-m", "init"]);

  const draftFile = join(root, ".steadfast", "decisions", "ADR-0001.yaml");
  writeFileSync(
    draftFile,
    readFileSync(draftFile, "utf8").replace(/^decision:.*$/m, "decision: Edited draft."),
  );
  const draftEdit = cli(["check", "--diff", "HEAD"], root);
  assert.equal(draftEdit.status, 0, draftEdit.stdout + draftEdit.stderr);
  assert.doesNotMatch(draftEdit.stdout, /history\/edited-record/);

  const activeFile = join(root, ".steadfast", "decisions", "ADR-0002.yaml");
  renameSync(activeFile, activeFile.replace(/\.yaml$/, ".yml"));
  git(["add", "-A"]);
  const renamed = cli(["check", "--diff", "HEAD"], root);
  assert.equal(renamed.status, 1);
  assert.match(renamed.stdout, /history\/renamed-record/);
});

test("new rejects over-budget and missing enforcement before writing", () => {
  const root = tempDir();
  write(root, "src/a.ts", "a");
  assert.equal(cli(["init"], root).status, 0);

  const over = cli(
    [
      "new",
      "--scope",
      "global",
      "--topic",
      "too-big",
      "--decision",
      "x".repeat(180),
      "--why",
      "y".repeat(160),
      "--why",
      "y".repeat(160),
      "--why",
      "y".repeat(160),
      "--applies-to",
      "src/**",
      "--status",
      "active",
      "--enforced-by",
      "src/a.ts",
    ],
    root,
  );
  assert.equal(over.status, 2);
  assert.match(over.stderr, /token/);

  const missing = cli(
    [
      "new",
      "--scope",
      "global",
      "--topic",
      "missing",
      "--decision",
      "Rule.",
      "--applies-to",
      "src/**",
      "--status",
      "active",
      "--enforced-by",
      "test/missing.ts",
    ],
    root,
  );
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /enforced_by/);

  assert.equal(existsSync(join(root, ".steadfast", "decisions", "ADR-0001.yaml")), false);
});

test("check --diff uses the merge base, not the base tip", () => {
  const root = tempDir();
  write(root, "src/a.ts", "a");

  const git = (args: string[]): string => {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  };
  git(["init"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);

  assert.equal(cli(["init"], root).status, 0);
  assert.equal(
    cli(
      [
        "new",
        "--scope",
        "global",
        "--topic",
        "base",
        "--decision",
        "Base rule.",
        "--applies-to",
        "src/**",
        "--status",
        "active",
        "--enforced-by",
        "src/a.ts",
      ],
      root,
    ).status,
    0,
  );

  git(["add", "-A"]);
  git(["commit", "-m", "base"]);
  const baseSha = git(["rev-parse", "HEAD"]);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);

  assert.equal(
    cli(
      [
        "new",
        "--scope",
        "global",
        "--topic",
        "later",
        "--decision",
        "Landed on the base branch later.",
        "--applies-to",
        "package.json",
        "--status",
        "active",
        "--enforced-by",
        "src/a.ts",
      ],
      root,
    ).status,
    0,
  );
  git(["add", "-A"]);
  git(["commit", "-m", "later"]);

  git(["checkout", "-b", "feature", baseSha]);
  write(root, "src/b.ts", "b");
  git(["add", "-A"]);
  git(["commit", "-m", "feature"]);

  const result = cli(["check", "--diff", branch, "--no-freshness"], root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /history\/deleted-record/);
});


