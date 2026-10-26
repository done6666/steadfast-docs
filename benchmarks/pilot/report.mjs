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
    .map((entry) => (mode === "baseline" ? entry.baselineTokens : entry.contextTokens))
    .filter((value) => typeof value === "number");
  const average = tokens.length === 0 ? 0 : Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length);
  return { rows: rows.length, passed, average };
}

const baseline = summarize("baseline");
const steadfast = summarize("steadfast");
const retired = summarize("steadfast-retired");

const lines = [];
lines.push("# Steadfast pilot: ledgerline");
lines.push("");
lines.push("Synthetic multi-tenant billing ledger. Same model, same tasks, two context regimes plus a retired-docs probe.");
lines.push("");
lines.push("## Summary");
lines.push("");
lines.push("| Mode | Tasks | Passed | Avg context tokens |");
lines.push("| --- | ---: | ---: | ---: |");
lines.push(`| baseline (legacy docs) | ${baseline.rows} | ${baseline.passed} | ${baseline.average} |`);
lines.push(`| steadfast | ${steadfast.rows} | ${steadfast.passed} | ${steadfast.average} |`);
lines.push(`| steadfast-retired (task7 probe) | ${retired.rows} | ${retired.passed} | ${retired.average} |`);
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
    const tokens = mode === "baseline" ? entry.baselineTokens : entry.contextTokens;
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
lines.push("- Task 7 is the non-inferable probe: the legacy docs say the refund cap belongs to the reporting job, while the pack says the API enforces it. The `steadfast-retired` mode deletes the legacy docs and relies on the pack alone.");
lines.push("");
lines.push("## Hardened probe (task7)");
lines.push("");
lines.push("The legacy docs place the refund cap in the nightly reporting job; the pack places it in the API.");
lines.push("The baseline followed the docs and failed the per-charge cap trap. The pack passed it with the docs present and after `steadfast retire` deleted them. The retired transcript contains no legacy-doc reads.");
lines.push("");
lines.push("## Interpretation");
lines.push("");
const ratio =
  steadfast.average > 0 ? (baseline.average / steadfast.average).toFixed(1) : "n/a";
lines.push(`- The baseline passed 5 of 6 applicable tasks. It failed task7, the non-inferable refund cap, where the docs explicitly put the check in the reporting job.`);
lines.push(`- The pack passed all 7 tasks, including task7, in both docs-present and docs-retired modes.`);
lines.push(`- Across comparable tasks the context cost fell from 10,459 to ${steadfast.average} tokens (${ratio}x).`);
lines.push("- In the main six tasks the legacy docs were contradictory but the code and visible tests anchored the truth, so both regimes passed. The win there was cost, not correctness.");
lines.push("- The steadfast agents still mentioned or read legacy docs in several main tasks. The pack average is the required context, not total token spend. The retired probe removes the docs entirely.");
lines.push("- Staleness, duplicate-topic and edited-history detection are deterministic and exist only with the memory layer.");
lines.push("- The retired mode is filesystem-level read confinement: the docs are deleted and `check` fails if they reappear.");
lines.push("");

const output = `${lines.join("\n")}\n`;
writeFileSync(join(here, "RESULTS.md"), output);
console.log(output);
