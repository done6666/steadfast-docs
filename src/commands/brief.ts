import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildFindingGraph, findingTokens, staleFindingAge } from "../core/finding.js";
import { tryGit } from "../core/git.js";
import { buildGraph } from "../core/graph.js";
import { loadRoadmap, stepTokens } from "../core/roadmap.js";
import { loadProject } from "../core/store.js";
import { estimateTokens, recordTokens } from "../core/tokens.js";
import { write, writeError } from "../output.js";
import { truncate } from "../util.js";
import type { Issue, Roadmap, Step } from "../types.js";
import { resolveExistingRoot } from "./shared.js";

interface GitState {
  branch?: string;
  dirty: number;
  worktrees: string[];
  recent: string[];
  unpushed?: number;
}

interface Section {
  name: string;
  lines: string[];
  optional: boolean;
}

function gitState(root: string): GitState {
  const branch = tryGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = tryGit(root, ["status", "--porcelain"]) ?? "";
  const worktreesRaw = tryGit(root, ["worktree", "list", "--porcelain"]) ?? "";
  const worktrees: string[] = [];
  for (const line of worktreesRaw.split("\n")) {
    const match = /^branch refs\/heads\/(.+)$/.exec(line);
    if (match) worktrees.push(match[1]!);
  }
  const recent = (tryGit(root, ["log", "-3", "--format=%h %s"]) ?? "")
    .split("\n")
    .filter(Boolean);
  const ahead = tryGit(root, ["rev-list", "--count", "@{u}..HEAD"]);
  const unpushed = ahead === undefined ? undefined : Number.parseInt(ahead, 10);
  return {
    ...(branch === undefined ? {} : { branch }),
    dirty: status.split("\n").filter(Boolean).length,
    worktrees,
    recent,
    ...(unpushed !== undefined && Number.isFinite(unpushed) && unpushed > 0 ? { unpushed } : {}),
  };
}

function readmeStatus(root: string): string[] {
  const path = join(root, "README.md");
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const match = /^##\s+Status\s*$/m.exec(text);
  if (match === null) return [];
  const rest = text.slice(match.index + match[0].length);
  const end = /^##\s+/m.exec(rest);
  const body = (end === null ? rest : rest.slice(0, end.index)).trim();
  if (body.length === 0) return [];
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function stepLine(step: Step): string {
  return `- ${step.id} ${step.goal}`;
}

function stepDetail(step: Step): string[] {
  return [
    stepLine(step),
    `  why: ${step.why}`,
    `  acceptance: ${step.acceptance}`,
    `  paths: ${step.paths.join(", ")}`,
    ...(step.decisions === undefined ? [] : [`  decisions: ${step.decisions.join(", ")}`]),
    ...(step.findings === undefined ? [] : [`  findings: ${step.findings.join(", ")}`]),
  ];
}

function roadmapSections(roadmap: Roadmap | undefined): {
  summary: string[];
  current: Section;
  next: Section;
  blocked: Section;
} {
  if (roadmap === undefined) {
    return {
      summary: ["roadmap: none (create .steadfast/roadmap.yaml)"],
      current: { name: "current", lines: [], optional: false },
      next: { name: "next", lines: [], optional: true },
      blocked: { name: "blocked", lines: [], optional: true },
    };
  }

  const counts = { todo: 0, current: 0, blocked: 0, done: 0, dropped: 0 };
  for (const step of roadmap.steps) counts[step.status] += 1;
  const summary = [
    `roadmap: ${counts.todo} todo, ${counts.done} done, ${counts.blocked} blocked, ${counts.current} current`,
  ];

  const currentStep = roadmap.steps.find((step) => step.status === "current");
  const current =
    currentStep === undefined
      ? { name: "current", lines: ["current: none"], optional: false }
      : { name: "current", lines: ["current:", ...stepDetail(currentStep).map((line) => `  ${line}`)], optional: false };

  const nextSteps = roadmap.steps.filter((step) => step.status === "todo").slice(0, 2);
  const next =
    nextSteps.length === 0
      ? { name: "next", lines: [], optional: true }
      : { name: "next", lines: ["next:", ...nextSteps.map((step) => `  ${stepLine(step)}`)], optional: true };

  const blockedSteps = roadmap.steps.filter((step) => step.status === "blocked");
  const blocked =
    blockedSteps.length === 0
      ? { name: "blocked", lines: [], optional: true }
      : {
          name: "blocked",
          lines: [
            "blocked:",
            ...blockedSteps.slice(0, 3).map((step) => `  ${stepLine(step)} (${step.blocked_by ?? "no reason"})`),
          ],
          optional: true,
        };

  return { summary, current, next, blocked };
}

function memoryLine(
  loaded: ReturnType<typeof loadProject>,
  graph: ReturnType<typeof buildGraph>,
): { line: string; tokens: number } {
  const counts = { active: 0, superseded: 0, rejected: 0, retired: 0, draft: 0 };
  for (const decision of loaded.decisions) {
    const status = graph.resolved.get(decision.id) ?? decision.status;
    counts[status] += 1;
  }
  const advisory = loaded.decisions.filter(
    (decision) =>
      graph.resolved.get(decision.id) === "active" && decision.enforced_by === undefined,
  ).length;
  const tokens =
    loaded.decisions.reduce((sum, decision) => sum + recordTokens(decision), 0) +
    loaded.invariants.reduce((sum, invariant) => sum + estimateTokens(JSON.stringify(invariant)), 0);
  return {
    line: `memory: ${counts.active} active, ${counts.superseded} superseded, ${counts.rejected} rejected, ${counts.draft} draft, ${advisory} advisory | ${tokens} tokens`,
    tokens,
  };
}

const HEADER_RESERVE = 24;

function render(
  sections: Section[],
  budget: number,
): { ok: boolean; text: string; tokens: number; omitted: string[] } {
  const omitted: string[] = [];
  const bodyBudget = Math.max(1, budget - HEADER_RESERVE);
  let present = sections.filter((section) => section.lines.length > 0);
  const count = (): number => estimateTokens(present.flatMap((section) => section.lines).join("\n"));

  for (const name of ["readme", "recent", "blocked", "next", "warnings", "worktrees"]) {
    if (count() <= bodyBudget) break;
    const section = present.find((item) => item.name === name);
    if (section !== undefined && section.optional) {
      present = present.filter((item) => item !== section);
      omitted.push(name);
    }
  }

  if (count() > bodyBudget) {
    present = present.map((section) => ({
      ...section,
      lines: section.lines.map((line) => truncate(line, 100)),
    }));
  }
  if (count() > bodyBudget) {
    present = present.map((section) => ({
      ...section,
      lines: section.lines.filter((line) => !line.trimStart().startsWith("why:")),
    }));
  }
  if (count() > bodyBudget) {
    present = present.map((section) => ({
      ...section,
      lines: section.lines.map((line) => truncate(line, 60)),
    }));
  }
  if (count() > bodyBudget) {
    const current = present.find((section) => section.name === "current");
    const summary = present.filter((section) =>
      ["memory", "git", "roadmap"].includes(section.name),
    );
    const fallback =
      current === undefined
        ? summary
        : [...summary, { ...current, lines: current.lines.slice(0, 2).map((line) => truncate(line, 60)) }];
    present = fallback;
    omitted.push("detail");
  }

  const body = present.flatMap((section) => section.lines).join("\n");
  let text = "";
  let tokens = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const header = [
      "# steadfast brief v1",
      `# budget: ${tokens}/${budget} | omitted: ${omitted.length}`,
    ];
    text = [...header, body].join("\n");
    tokens = estimateTokens(text);
  }
  return { ok: tokens <= budget, text, tokens, omitted };
}

function formatIssues(issues: Issue[]): string[] {
  return issues.map((issue) => {
    const location = issue.id === undefined ? "" : ` [${issue.id}]`;
    const fix = issue.fix === undefined ? "" : ` fix: ${issue.fix}`;
    return `${issue.severity}: ${issue.code}${location} ${issue.message}${fix}`;
  });
}

export async function briefCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      json: { type: "boolean", default: false },
      budget: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  if (values.help) {
    write("steadfast brief [--json] [--budget <tokens>]");
    write("");
    write("  Prints the current roadmap step, next steps, blockers, recent commits,");
    write("  worktrees and memory stats. Run at the start of a session.");
    write("  --budget may only lower budgets.brief_tokens.");
    return 0;
  }

  const root = resolveExistingRoot(values.root);
  if (root === undefined) {
    writeError("error: not a steadfast project (no .steadfast directory); run: steadfast init");
    return 2;
  }

  const loaded = loadProject(root);
  const graph = buildGraph(loaded.decisions, loaded.files);
  const findingGraph = buildFindingGraph(loaded.findings, loaded.findingFiles);
  const known = new Set(loaded.decisions.map((decision) => decision.id));
  const roadmap = loadRoadmap(root, known, new Set(loaded.findings.map((finding) => finding.id)));
  const issues = [...loaded.issues, ...graph.issues, ...findingGraph.issues, ...roadmap.issues];
  const errors = issues.filter((issue) => issue.severity === "error");

  let cap = loaded.config.budgets.brief_tokens;
  if (values.budget !== undefined) {
    if (!/^[0-9]+$/.test(values.budget)) {
      writeError("error: --budget must be a positive integer");
      return 2;
    }
    const requested = Number(values.budget);
    if (!Number.isSafeInteger(requested) || requested < 120) {
      writeError("error: --budget must be an integer of at least 120 tokens");
      return 2;
    }
    cap = Math.min(cap, requested);
  }

  if (errors.length > 0) {
    if (values.json) {
      write(JSON.stringify({ ok: false, issues, text: "" }, null, 2));
    } else {
      for (const issue of formatIssues(issues)) writeError(issue);
      writeError("error: fix the memory before asking for a brief");
    }
    return 1;
  }

  const git = gitState(root);
  const memory = memoryLine(loaded, graph);
  const findingCounts = { active: 0, superseded: 0, retracted: 0, retired: 0 };
  let staleFindings = 0;
  for (const finding of loaded.findings) {
    const status = findingGraph.resolved.get(finding.id) ?? finding.status;
    findingCounts[status] += 1;
    if (
      status === "active" &&
      staleFindingAge(finding, loaded.config.findings_ttl_days) !== undefined
    ) {
      staleFindings += 1;
    }
  }
  const findingLine =
    loaded.findings.length === 0
      ? []
      : [
          `findings: ${findingCounts.active} active, ${findingCounts.superseded} superseded, ${findingCounts.retracted} retracted, ${findingCounts.retired} retired, ${staleFindings} stale | ${loaded.findings.reduce(
            (sum, finding) => sum + findingTokens(finding),
            0,
          )} tokens`,
        ];
  const sections = roadmapSections(roadmap.roadmap);
  const readme = readmeStatus(root);
  const roadmapWarnings = roadmap.issues
    .filter((issue) => issue.severity === "warning")
    .map((issue) => `${issue.code}: ${issue.message}`);
  const worktreeLine =
    git.worktrees.length <= 1
      ? []
      : [
          `worktrees: ${git.worktrees.slice(0, 3).join(", ")}${
            git.worktrees.length > 3 ? ` +${git.worktrees.length - 3}` : ""
          }`,
        ];

  const allSections: Section[] = [
    { name: "memory", lines: [memory.line], optional: false },
    { name: "findings", lines: findingLine, optional: false },
    {
      name: "git",
      lines: [
        `git: ${git.branch ?? "no branch"} | ${git.dirty === 0 ? "clean" : `${git.dirty} changed`} | ${git.worktrees.length} worktree${git.worktrees.length === 1 ? "" : "s"}${
          git.unpushed === undefined ? "" : ` | ${git.unpushed} unpushed`
        }`,
      ],
      optional: false,
    },
    { name: "worktrees", lines: worktreeLine, optional: true },
    { name: "roadmap", lines: sections.summary, optional: false },
    sections.current,
    {
      name: "warnings",
      lines:
        roadmapWarnings.length === 0
          ? []
          : ["warnings:", ...roadmapWarnings.slice(0, 3).map((line) => `  - ${line}`)],
      optional: true,
    },
    sections.next,
    sections.blocked,
    {
      name: "recent",
      lines: git.recent.length === 0 ? [] : ["recent:", ...git.recent.map((line) => `  - ${line}`)],
      optional: true,
    },
    {
      name: "readme",
      lines: readme.length === 0 ? [] : ["readme:", ...readme.map((line) => `  ${line}`)],
      optional: true,
    },
  ];

  const output = render(allSections, cap);
  if (!output.ok) {
    if (values.json) {
      write(
        JSON.stringify(
          {
            ok: false,
            tokens: output.tokens,
            budget: cap,
            omitted: output.omitted,
            error: `brief needs ${output.tokens} tokens; budget is ${cap}`,
          },
          null,
          2,
        ),
      );
    } else {
      writeError(
        `error: brief needs ${output.tokens} tokens; budget is ${cap}; raise budgets.brief_tokens or lower detail`,
      );
    }
    return 2;
  }
  const currentStep = roadmap.roadmap?.steps.find((step) => step.status === "current");
  const next = roadmap.roadmap?.steps.filter((step) => step.status === "todo").slice(0, 2) ?? [];
  const blocked = roadmap.roadmap?.steps.filter((step) => step.status === "blocked") ?? [];

  if (values.json) {
    write(
      JSON.stringify(
        {
          ok: true,
          text: output.text,
          tokens: output.tokens,
          budget: cap,
          omitted: output.omitted,
          current: currentStep?.id ?? null,
          next: next.map((step) => step.id),
          blocked: blocked.map((step) => step.id),
          memory: { tokens: memory.tokens },
          findings: { ...findingCounts, stale: staleFindings },
          git,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  write(output.text);
  return 0;
}

export function briefTokenCost(step: Step): number {
  return stepTokens(step);
}
