import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const framework = resolve(here, "..", "..");
const cli = join(framework, "dist", "src", "cli.js");
const fixture = join(here, "fixture");
const seed = join(here, "steadfast");
const tmpRoot = "/tmp/opencode";

function copy() {
  const dir = mkdtempSync(join(tmpRoot, "pilot-stale-"));
  cpSync(fixture, dir, { recursive: true });
  cpSync(join(seed, ".steadfast"), join(dir, ".steadfast"), { recursive: true });
  cpSync(join(seed, "AGENTS.md"), join(dir, "AGENTS.md"));
  return dir;
}

function run(args, cwd) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", PWD: cwd },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const fresh = copy();
const freshCheck = run(["check", "--strict"], fresh);

const stale = copy();
execFileSync("sh", ["-c", "printf '\\n// stale probe\\n' >> packages/ledger/money.js"], {
  cwd: stale,
});
const staleCheck = run(["check"], stale);
const verified = run(["verify", "ADR-0001", "--assume"], stale);
const healedCheck = run(["check", "--strict"], stale);

const duplicate = copy();
const moneyRule = readFileSync(
  join(duplicate, ".steadfast", "decisions", "ADR-0001.yaml"),
  "utf8",
);
writeFileSync(
  join(duplicate, ".steadfast", "decisions", "ADR-9999.yaml"),
  moneyRule
    .replace(/^id: .*$/m, "id: ADR-9999")
    .replace(/^decision: .*$/m, "decision: Duplicate money rule."),
);
const duplicateCheck = run(["check"], duplicate);

const history = copy();
git(["init", "-q"], history);
git(["config", "user.email", "pilot@example.com"], history);
git(["config", "user.name", "pilot"], history);
git(["add", "-A"], history);
git(["commit", "-qm", "base"], history);
const base = git(["rev-parse", "HEAD"], history);
const recordPath = join(history, ".steadfast", "decisions", "ADR-0001.yaml");
writeFileSync(
  recordPath,
  readFileSync(recordPath, "utf8").replace(
    /^decision: .*$/m,
    "decision: Edited without a successor.",
  ),
);
const historyCheck = run(["check", "--diff", base], history);

const result = {
  fresh: {
    detected: freshCheck.status === 0,
    code: freshCheck.status === 0 ? null : "unexpected",
  },
  staleFingerprint: {
    detected: staleCheck.status === 1 && staleCheck.stdout.includes("fresh/stale"),
    code: "fresh/stale",
    healed: verified.status === 0 && healedCheck.status === 0,
  },
  duplicateTopic: {
    detected:
      duplicateCheck.status === 1 && duplicateCheck.stdout.includes("graph/duplicate-topic"),
    code: "graph/duplicate-topic",
  },
  editedHistory: {
    detected:
      historyCheck.status === 1 && historyCheck.stdout.includes("history/edited-record"),
    code: "history/edited-record",
  },
  legacyContradictions: 4,
  baselineDetector: false,
};

writeFileSync(join(here, "staleness.json"), JSON.stringify(result, null, 2));

const ok = (value) => (value ? "detected" : "MISSED");
console.log(`fresh seed:        ${freshCheck.status === 0 ? "valid" : "invalid"}`);
console.log(`stale fingerprint: ${ok(result.staleFingerprint.detected)} (${result.staleFingerprint.code})`);
console.log(`duplicate topic:   ${ok(result.duplicateTopic.detected)} (${result.duplicateTopic.code})`);
console.log(`edited history:    ${ok(result.editedHistory.detected)} (${result.editedHistory.code})`);
console.log(`legacy docs:       ${result.legacyContradictions} contradictions, no detector`);
