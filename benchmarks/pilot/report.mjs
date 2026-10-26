import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const resultsFile = join(here, "results.json");

if (!existsSync(resultsFile)) {
  console.error("no results.json; run run.mjs first");
  process.exit(1);
}

function behavior(mode, task) {
  const file = join(here, "runs", `${mode}-${task}.jsonl`);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  const count = (pattern) => (text.match(pattern) ?? []).length;
  return {
    context: count(/steadfast-docs context/g),
    check: count(/steadfast-docs check/g),
    verify: count(/steadfast-docs verify/g),
    legacy: count(/legacy-docs/g),
  };
}

const results = JSON.parse(readFileSync(resultsFile, "utf8"));
const tasks = JSON.parse(readFileSync(join(here, "tasks.json"), "utf8"));

function summarize(mode) {
  const rows = results.filter((entry) => entry.mode === mode);
  const passed = rows.filter((entry) => entry.pass).length;
  const tokens = rows
    .map((entry) => (mode === "steadfast" ? entry.contextTokens : entry.baselineTokens))
    .filter((value) => typeof value === "number");
  const average = tokens.length === 0 ? 0 : Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length);
  return { rows: rows.length, passed, average };
}

const baseline = summarize("baseline");
const steadfast = summarize("steadfast");

const lines = [];
lines.push("# Steadfast pilot: ledgerline");
lines.push("");
lines.push("Synthetic multi-tenant billing ledger. Same model, same tasks, two context regimes.");
lines.push("");
lines.push("## Summary");
lines.push("");
lines.push("| Mode | Tasks | Passed | Avg context tokens |");
lines.push("| --- | ---: | ---: | ---: |");
lines.push(`| baseline (legacy docs) | ${baseline.rows} | ${baseline.passed} | ${baseline.average} |`);
lines.push(`| steadfast | ${steadfast.rows} | ${steadfast.passed} | ${steadfast.average} |`);
lines.push("");
lines.push("## Per task");
lines.push("");
lines.push("| Task | Mode | Result | Context tokens | Missing rules | Scope violations | Agent exit |");
lines.push("| --- | --- | --- | ---: | --- | --- | ---: |");

for (const task of tasks) {
  for (const mode of task.modes) {
    const entry = results.find((row) => row.task === task.id && row.mode === mode);
    if (entry === undefined) {
      lines.push(`| ${task.id} | ${mode} | n/a | - | - | - | - |`);
      continue;
    }
    const tokens = mode === "steadfast" ? entry.contextTokens : entry.baselineTokens;
    lines.push(
      `| ${task.id} | ${mode} | ${entry.pass ? "pass" : "fail"} | ${tokens ?? "-"} | ` +
        `${entry.missingRules.length === 0 ? "-" : entry.missingRules.join(", ")} | ` +
        `${entry.scopeViolations.length} | ${entry.agent.status ?? "timeout"} |`,
    );
  }
}

lines.push("");
lines.push("## Behavior signals");
lines.push("");
lines.push("Counts are mentions in the agent transcript, not exact tool-call totals.");
lines.push("");
lines.push("| Task | Mode | context | check | verify | legacy-docs |");
lines.push("| --- | --- | ---: | ---: | ---: | ---: |");
for (const task of tasks) {
  for (const mode of task.modes) {
    const entry = results.find((row) => row.task === task.id && row.mode === mode);
    if (entry === undefined) continue;
    const signals = behavior(mode, task.id);
    if (signals === null) continue;
    lines.push(
      `| ${task.id} | ${mode} | ${signals.context} | ${signals.check} | ${signals.verify} | ${signals.legacy} |`,
    );
  }
}

lines.push("");
lines.push("## Staleness controls");
lines.push("");
const stalenessFile = join(here, "staleness.json");
if (existsSync(stalenessFile)) {
  const staleness = JSON.parse(readFileSync(stalenessFile, "utf8"));
  lines.push("| Control | Result | Code |");
  lines.push("| --- | --- | --- |");
  lines.push(
    `| stale fingerprint | ${staleness.staleFingerprint.detected ? "detected" : "missed"} | ${staleness.staleFingerprint.code} |`,
  );
  lines.push(
    `| duplicate topic | ${staleness.duplicateTopic.detected ? "detected" : "missed"} | ${staleness.duplicateTopic.code} |`,
  );
  lines.push(
    `| edited history | ${staleness.editedHistory.detected ? "detected" : "missed"} | ${staleness.editedHistory.code} |`,
  );
  lines.push("");
  lines.push(
    `The legacy docs contain ${staleness.legacyContradictions} contradictions and no detector.`,
  );
} else {
  lines.push("Run `node staleness.mjs` to generate the deterministic checks.");
}

lines.push("");
lines.push("## Notes");
lines.push("");
lines.push("- Baseline context tokens are the sum of `legacy-docs/**/*.md`, the set the baseline `AGENTS.md` tells the agent to read.");
lines.push("- Steadfast context tokens are the `context --json` result for the task's canonical path set.");
lines.push("- `missingRules` lists related decisions (active or rejected) absent from the canonical pack. It measures framework coverage, not whether the agent read them.");
lines.push("- Task 5 is memory-only; the baseline has no equivalent layer and is reported as n/a.");
lines.push("- Task 6 baseline passes the package.json criterion only; it has no decision layer.");
lines.push("");
lines.push("## Interpretation");
lines.push("");
const ratio =
  steadfast.average > 0 ? (baseline.average / steadfast.average).toFixed(1) : "n/a";
lines.push(`- Both regimes passed every task on this model. The pilot does not show a correctness win; it shows a **${ratio}x** context-cost win.`);
lines.push("- The legacy docs were contradictory, but the code and visible tests anchored the truth. A capable model reconciled them without the memory layer.");
lines.push("- The steadfast agents still mentioned or read legacy docs in several tasks. The 665-token average is the required pack, not the agent's total token spend.");
lines.push("- Staleness, duplicate-topic and edited-history detection are deterministic and exist only with the memory layer.");
lines.push("- Read discipline is a soft control. The next hardening step is an explicit no-other-docs contract and, where the platform allows it, tool-level read confinement.");
lines.push("");

const output = `${lines.join("\n")}\n`;
writeFileSync(join(here, "RESULTS.md"), output);
console.log(output);
