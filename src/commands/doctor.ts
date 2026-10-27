import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { buildFindingGraph, staleFindingAge } from "../core/finding.js";
import { buildGraph } from "../core/graph.js";
import { safeFile } from "../core/paths.js";
import { loadRoadmap } from "../core/roadmap.js";
import { installedSkillTargets, readCanonicalSkill } from "../core/skill.js";
import { loadProject } from "../core/store.js";
import { paint, write, writeError } from "../output.js";
import { hookPathFor } from "./hook.js";
import { resolveExistingRoot } from "./shared.js";

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

interface CheckItem {
  id: string;
  status: "ok" | "warn" | "error";
  message: string;
  fix?: string;
}

interface CheckReport {
  ok?: boolean;
  stats?: Record<string, number>;
  issues?: Array<{ severity: string; code: string; message: string; fix?: string }>;
}

function nodeOk(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major > 20 || (major === 20 && minor >= 11);
}

function runCheck(root: string): CheckReport | undefined {
  const result = spawnSync(process.execPath, [CLI, "check", "--json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", PWD: root },
  });
  if (result.stdout.trim().length === 0) return undefined;
  try {
    return JSON.parse(result.stdout) as CheckReport;
  } catch {
    return undefined;
  }
}

function mcpConfigured(root: string): boolean {
  const files = [
    join(root, "opencode.json"),
    join(root, "opencode.jsonc"),
    join(root, ".opencode", "opencode.json"),
    join(root, ".opencode", "opencode.jsonc"),
    join(root, ".mcp.json"),
    join(root, ".claude", "settings.json"),
    join(homedir(), ".config", "opencode", "opencode.json"),
    join(homedir(), ".config", "opencode", "opencode.jsonc"),
    join(homedir(), ".claude.json"),
  ];
  return files.some((path) => {
    if (!existsSync(path)) return false;
    const text = readFileSync(path, "utf8");
    return (
      text.includes("steadfast") &&
      (text.includes("steadfast-docs") || text.includes("cli.js"))
    );
  });
}

function hookInstalled(root: string): boolean {
  const path = hookPathFor(root);
  return path !== undefined && existsSync(path) && readFileSync(path, "utf8").includes("steadfast");
}

export async function doctorCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  if (values.help) {
    write("steadfast doctor [--json]");
    write("");
    write("  Diagnoses the agent contract, skill copy, MCP config, hook,");
    write("  freshness, advisory rules, budgets and retired docs.");
    return 0;
  }

  const root = resolveExistingRoot(values.root);
  if (root === undefined) {
    writeError("error: not a steadfast project (no .steadfast directory); run: steadfast init");
    return 2;
  }

  const checks: CheckItem[] = [];
  const add = (status: CheckItem["status"], id: string, message: string, fix?: string): void => {
    checks.push({ id, status, message, ...(fix === undefined ? {} : { fix }) });
  };

  add(
    nodeOk() ? "ok" : "error",
    "node",
    `node ${process.versions.node} (requires >=20.11)`,
    nodeOk() ? undefined : "upgrade Node to 20.11 or newer",
  );

  for (const [id, path] of [
    ["config", ".steadfast/config.yaml"],
    ["invariants", ".steadfast/invariants.yaml"],
    ["decisions", ".steadfast/decisions"],
    ["findings", ".steadfast/findings"],
  ] as const) {
    const exists = existsSync(join(root, path));
    add(exists ? "ok" : "error", id, path, exists ? undefined : "run: steadfast init");
  }

  const agentsPath = join(root, "AGENTS.md");
  const agents = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : "";
  add(
    agents.includes("<!-- steadfast:begin -->") ? "ok" : "warn",
    "agents",
    "AGENTS.md contract",
    agents.includes("<!-- steadfast:begin -->") ? undefined : "run: steadfast init",
  );

  const skillTargets = installedSkillTargets(root);
  if (skillTargets.length === 0) {
    add(
      "warn",
      "skill",
      "no project skill copy",
      "run: steadfast skill install --platform opencode",
    );
  } else {
    try {
      const canonical = readCanonicalSkill();
      const stale: typeof skillTargets = [];
      let outside = false;
      for (const target of skillTargets) {
        const file = relative(root, target.path).replace(/\\/g, "/");
        const safe = safeFile(root, file);
        if (safe === undefined) {
          outside = true;
          add(
            "error",
            "skill",
            `${target.platform} skill path escapes the project`,
            `run: steadfast skill install --platform ${target.platform} --force`,
          );
          continue;
        }
        if (readFileSync(safe, "utf8") !== canonical) stale.push(target);
      }
      if (!outside) {
        add(
          stale.length === 0 ? "ok" : "error",
          "skill",
          stale.length === 0
            ? `${skillTargets.length} skill copy in sync`
            : `stale skill copy: ${stale.map((target) => target.platform).join(", ")}`,
          stale.length === 0
            ? undefined
            : `run: steadfast skill install --platform ${stale[0]!.platform} --force`,
        );
      }
    } catch (error) {
      add("error", "skill", `cannot read canonical skill: ${(error as Error).message}`);
    }
  }

  add(
    hookInstalled(root) ? "ok" : "warn",
    "hook",
    "pre-commit hook",
    hookInstalled(root) ? undefined : "run: steadfast hook install",
  );

  add(
    mcpConfigured(root) ? "ok" : "warn",
    "mcp",
    "MCP server config",
    mcpConfigured(root) ? undefined : "run: steadfast mcp install --platform opencode",
  );

  const report = runCheck(root);
  if (report === undefined) {
    add("error", "check", "check did not return a machine-readable report", "run: steadfast check");
  } else {
    const errors = report.stats?.errors ?? 0;
    const warnings = report.stats?.warnings ?? 0;
    add(
      errors === 0 ? (warnings === 0 ? "ok" : "warn") : "error",
      "check",
      `${errors} errors, ${warnings} warnings`,
      errors === 0
        ? warnings === 0
          ? undefined
          : "run: steadfast check"
        : "run: steadfast check --strict",
    );
  }

  const loaded = loadProject(root);
  const graph = buildGraph(loaded.decisions, loaded.files);
  const advisory = loaded.decisions.filter(
    (decision) =>
      graph.resolved.get(decision.id) === "active" && decision.enforced_by === undefined,
  );
  add(
    advisory.length === 0 ? "ok" : "warn",
    "advisory",
    advisory.length === 0
      ? "every active rule has an enforced_by"
      : `${advisory.length} advisory rule(s): ${advisory.map((decision) => decision.id).join(", ")}`,
    advisory.length === 0 ? undefined : "add enforced_by, or supersede the rule",
  );

  const roadmap = loadRoadmap(
    root,
    new Set(loaded.decisions.map((decision) => decision.id)),
    new Set(loaded.findings.map((finding) => finding.id)),
  );
  const roadmapErrors = roadmap.issues.filter((issue) => issue.severity === "error").length;
  const roadmapCurrent = roadmap.roadmap?.steps.find((step) => step.status === "current");
  const roadmapTodo = roadmap.roadmap?.steps.filter((step) => step.status === "todo").length ?? 0;
  if (roadmapErrors > 0) {
    add("error", "roadmap", `roadmap has ${roadmapErrors} error(s)`, "run: steadfast check");
  } else if (roadmap.roadmap === undefined) {
    add("ok", "roadmap", "roadmap: not configured");
  } else if (roadmapCurrent === undefined && roadmapTodo > 0) {
    add(
      "warn",
      "roadmap",
      `roadmap: no current step (${roadmapTodo} todo)`,
      "set one step to status: current in .steadfast/roadmap.yaml",
    );
  } else {
    add(
      "ok",
      "roadmap",
      roadmapCurrent === undefined
        ? "roadmap: no open steps"
        : `roadmap: ${roadmapCurrent.id} ${roadmapCurrent.goal}`,
    );
  }

  const findingGraph = buildFindingGraph(loaded.findings, loaded.findingFiles);
  const findingErrors = findingGraph.issues.filter((issue) => issue.severity === "error").length;
  const activeFindings = loaded.findings.filter(
    (finding) => findingGraph.resolved.get(finding.id) === "active",
  );
  const staleFindings = activeFindings.filter(
    (finding) => staleFindingAge(finding, loaded.config.findings_ttl_days) !== undefined,
  ).length;
  if (loaded.findings.length === 0) {
    add("ok", "findings", "findings: none");
  } else if (findingErrors > 0) {
    add("error", "findings", `findings have ${findingErrors} error(s)`, "run: steadfast check");
  } else if (staleFindings > 0) {
    add(
      "warn",
      "findings",
      `${staleFindings} stale finding(s); ${activeFindings.length} active`,
      "re-observe the target and supersede stale findings",
    );
  } else {
    add("ok", "findings", `findings: ${activeFindings.length} active`);
  }

  const errors = checks.filter((check) => check.status === "error");
  const warnings = checks.filter((check) => check.status === "warn");

  if (values.json) {
    write(
      JSON.stringify(
        {
          ok: errors.length === 0,
          checks,
          stats: { errors: errors.length, warnings: warnings.length },
          check: report ?? null,
        },
        null,
        2,
      ),
    );
    return errors.length === 0 ? 0 : 1;
  }

  write(paint.bold("steadfast doctor"));
  for (const check of checks) {
    const label = check.status === "ok" ? paint.green("ok  ") : check.status === "warn" ? paint.yellow("warn") : paint.red("fail");
    write(`${label} ${check.message}`);
    if (check.fix !== undefined) write(`     fix: ${check.fix}`);
  }
  write("");
  const summary = `${errors.length} errors, ${warnings.length} warnings`;
  write(errors.length === 0 ? paint.green(summary) : paint.red(summary));
  return errors.length === 0 ? 0 : 1;
}
