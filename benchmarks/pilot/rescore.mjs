import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreRun } from "./score.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const resultsFile = join(here, "results.json");

if (!existsSync(resultsFile)) {
  console.error("no results.json; run run.mjs first");
  process.exit(1);
}

const tasks = JSON.parse(readFileSync(join(here, "tasks.json"), "utf8"));
const results = JSON.parse(readFileSync(resultsFile, "utf8"));
const updated = [];

for (const old of results) {
  const task = tasks.find((entry) => entry.id === old.task);
  if (task === undefined) continue;
  const score = scoreRun({
    dir: old.dir,
    task,
    mode: old.mode,
    base: old.base,
    here,
  });
  updated.push({
    ...old,
    ...score,
    model: old.model,
    base: old.base,
    agent: old.agent,
    timestamp: new Date().toISOString(),
  });
  console.log(`${score.pass ? "PASS" : "FAIL"} ${score.task}/${score.mode} scope=${score.scopeViolations.length} missing=${score.missingRules.join(",") || "-"}`);
}

writeFileSync(resultsFile, JSON.stringify(updated, null, 2));
