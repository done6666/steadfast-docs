import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreRun } from "./score.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const framework = resolve(here, "..", "..");
const fixture = join(here, "fixture");
const seed = join(here, "steadfast");
const cache = join(here, ".cache");
const runs = join(here, "runs");
const resultsFile = join(here, "results.json");
const tmpRoot = process.env.PILOT_TMP ?? "/tmp/opencode";

const args = process.argv.slice(2);
function flag(name) {
  return args.includes(name);
}
function option(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const model = option("--model", "opencode-go/deepseek-v4.1-flash");
const only = option("--only", "");
const requestedModes = option("--mode", "both");
const fresh = flag("--fresh");
const dry = flag("--dry");

mkdirSync(tmpRoot, { recursive: true });
mkdirSync(runs, { recursive: true });
mkdirSync(cache, { recursive: true });

if (fresh) {
  rmSync(runs, { recursive: true, force: true });
  mkdirSync(runs, { recursive: true });
  rmSync(resultsFile, { force: true });
  rmSync(cache, { recursive: true, force: true });
  mkdirSync(cache, { recursive: true });
}

const version = JSON.parse(readFileSync(join(framework, "package.json"), "utf8")).version;
const tarball = join(cache, `steadfast-docs-${version}.tgz`);

if (!existsSync(tarball)) {
  console.log("packing steadfast-docs ...");
  execFileSync("npm", ["pack", "--pack-destination", cache], {
    cwd: framework,
    stdio: "pipe",
  });
}

const tasks = JSON.parse(readFileSync(join(here, "tasks.json"), "utf8")).filter((task) =>
  only.length === 0 ? true : only.split(",").includes(task.id),
);

function command(commandName, commandArgs, cwd, timeout = 300_000) {
  const result = spawnSync(commandName, commandArgs, {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1", PWD: cwd },
  });
  return {
    ok: result.status === 0,
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function prepare(mode, task) {
  const dir = mkdtempSync(join(tmpRoot, `pilot-${mode}-${task.id}-`));
  cpSync(fixture, dir, { recursive: true });

  if (mode === "steadfast") {
    cpSync(join(seed, ".steadfast"), join(dir, ".steadfast"), { recursive: true });
    cpSync(join(seed, "AGENTS.md"), join(dir, "AGENTS.md"));

    const install = command(
      "npm",
      ["install", "--no-audit", "--no-fund", "--no-save", tarball],
      dir,
      600_000,
    );
    if (!install.ok) throw new Error(`npm install failed:\n${install.stdout}${install.stderr}`);

    const cli = join(dir, "node_modules", ".bin", "steadfast");
    const skill = command(cli, ["skill", "install", "--platform", "opencode"], dir);
    if (!skill.ok) throw new Error(`skill install failed:\n${skill.stdout}${skill.stderr}`);

    const check = command(cli, ["check", "--strict"], dir);
    if (!check.ok) throw new Error(`seed check failed:\n${check.stdout}${check.stderr}`);
  }

  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "pilot@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "pilot"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "pilot base"], { cwd: dir });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

  return { dir, base };
}

function loadResults() {
  if (!existsSync(resultsFile)) return [];
  try {
    return JSON.parse(readFileSync(resultsFile, "utf8"));
  } catch {
    return [];
  }
}

const results = loadResults();

for (const task of tasks) {
  const modes = task.modes.filter((mode) =>
    requestedModes === "both" ? true : requestedModes === mode,
  );

  for (const mode of modes) {
    console.log(`\n=== ${task.id} ${task.title} [${mode}] ===`);
    const { dir, base } = prepare(mode, task);

    let agent = { status: null, signal: null, timedOut: false, stdout: "", stderr: "" };
    if (!dry) {
      const prompt = readFileSync(join(here, task.prompt), "utf8");
      const message = [
        "You are working in this repository. Follow AGENTS.md.",
        "Complete the task below. Do not ask questions. Run the tests before finishing.",
        "Do not read or write outside this repository.",
        "Reply with a short summary.",
        "",
        "TASK:",
        prompt,
      ].join("\n");

      const started = Date.now();
      const execution = spawnSync(
        "opencode",
        ["run", "--standalone", "--format", "json", "--auto", "--model", model, message],
        {
          cwd: dir,
          encoding: "utf8",
          timeout: 900_000,
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, PWD: dir },
        },
      );

      agent = {
        status: execution.status,
        signal: execution.signal,
        timedOut: execution.error?.code === "ETIMEDOUT",
        stdout: execution.stdout ?? "",
        stderr: execution.stderr ?? "",
        durationMs: Date.now() - started,
      };

      writeFileSync(join(runs, `${mode}-${task.id}.jsonl`), agent.stdout);
      writeFileSync(join(runs, `${mode}-${task.id}.stderr.log`), agent.stderr);
    }

    const score = scoreRun({ dir, task, mode, base, here });
    const result = {
      ...score,
      model,
      base,
      agent: {
        status: agent.status,
        signal: agent.signal,
        timedOut: agent.timedOut,
        durationMs: agent.durationMs ?? 0,
      },
      timestamp: new Date().toISOString(),
    };

    const index = results.findIndex(
      (entry) => entry.task === result.task && entry.mode === result.mode,
    );
    if (index === -1) results.push(result);
    else results[index] = result;

    writeFileSync(join(runs, `${mode}-${task.id}.json`), JSON.stringify(result, null, 2));
    writeFileSync(resultsFile, JSON.stringify(results, null, 2));

    const tokens = mode === "steadfast" ? result.contextTokens : result.baselineTokens;
    const agentLabel = dry ? "skipped" : (result.agent.status ?? "timeout");
    console.log(
      `${result.pass ? "PASS" : "FAIL"} ${task.id}/${mode} tokens=${tokens ?? "?"} ` +
        `missing=${result.missingRules.join(",") || "-"} scope=${result.scopeViolations.length} ` +
        `agent=${agentLabel} dir=${result.dir}`,
    );
  }
}

console.log(`\nresults written to ${resultsFile}`);
