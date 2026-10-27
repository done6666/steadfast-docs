import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Issue, Roadmap, Severity, Step, StepStatus } from "../types.js";
import { estimateTokens } from "./tokens.js";
import { safeFile } from "./paths.js";
import { isObject } from "../util.js";

export const ROADMAP_FIELDS = ["version", "updated", "steps"] as const;
export const STEP_FIELDS = [
  "id",
  "goal",
  "why",
  "paths",
  "acceptance",
  "status",
  "evidence",
  "blocked_by",
  "decisions",
  "findings",
] as const;

const STEP_ID_RE = /^STEP-[0-9]{3,}$/;
const DECISION_ID_RE = /^ADR-[0-9]{4,}$/;
const FINDING_ID_RE = /^FIND-[0-9]{4,}$/;
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const STATUSES: readonly StepStatus[] = ["todo", "current", "blocked", "done", "dropped"];
const STALE_WARN_DAYS = 7;
const STALE_ERROR_DAYS = 30;
const DAY_MS = 86_400_000;
export const ROADMAP_FILE = ".steadfast/roadmap.yaml";

function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function error(
  issues: Issue[],
  code: string,
  message: string,
  file: string,
  id?: string,
  fix?: string,
): void {
  push(issues, "error", code, message, file, id, fix);
}

function warning(
  issues: Issue[],
  code: string,
  message: string,
  file: string,
  id?: string,
  fix?: string,
): void {
  push(issues, "warning", code, message, file, id, fix);
}

function push(
  issues: Issue[],
  severity: Severity,
  code: string,
  message: string,
  file: string,
  id?: string,
  fix?: string,
): void {
  const item: Issue = { severity, code, message, file };
  if (id !== undefined) item.id = id;
  if (fix !== undefined) item.fix = fix;
  issues.push(item);
}

function readString(
  raw: Record<string, unknown>,
  key: string,
  max: number,
  issues: Issue[],
  file: string,
  id: string | undefined,
  required: boolean,
): string | undefined {
  const value = raw[key];
  if (value === undefined) {
    if (required) error(issues, "schema/missing-field", `missing required field "${key}"`, file, id);
    return undefined;
  }
  if (typeof value !== "string") {
    error(issues, "schema/type", `"${key}" must be a string`, file, id);
    return undefined;
  }
  if (value.trim().length === 0) {
    error(issues, "schema/empty", `"${key}" must not be empty`, file, id);
    return undefined;
  }
  if (value.length > max) {
    error(
      issues,
      "budget/field-length",
      `"${key}" is ${value.length} chars; limit is ${max}`,
      file,
      id,
      "compress it to one fact",
    );
    return undefined;
  }
  return value;
}

function readArray(
  raw: Record<string, unknown>,
  key: string,
  maxItems: number,
  maxLength: number,
  issues: Issue[],
  file: string,
  id: string | undefined,
  required: boolean,
): string[] | undefined {
  const value = raw[key];
  if (value === undefined) {
    if (required) error(issues, "schema/missing-field", `missing required field "${key}"`, file, id);
    return undefined;
  }
  if (!Array.isArray(value)) {
    error(issues, "schema/type", `"${key}" must be a list`, file, id);
    return undefined;
  }
  if (required && value.length === 0) {
    error(issues, "schema/empty", `"${key}" must not be empty`, file, id);
    return undefined;
  }
  if (value.length > maxItems) {
    error(issues, "budget/list-length", `"${key}" has ${value.length} items; limit is ${maxItems}`, file, id);
    return undefined;
  }
  const out: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim().length === 0) {
      error(issues, "schema/type", `"${key}[${index}]" must be a non-empty string`, file, id);
      continue;
    }
    if (item.length > maxLength) {
      error(
        issues,
        "budget/field-length",
        `"${key}[${index}]" is ${item.length} chars; limit is ${maxLength}`,
        file,
        id,
      );
      continue;
    }
    out.push(item);
  }
  if (required && out.length === 0) {
    error(issues, "schema/empty", `"${key}" must contain at least one valid entry`, file, id);
    return undefined;
  }
  return out;
}

export function validateRoadmap(
  raw: unknown,
  file: string,
  knownDecisions?: Set<string>,
  knownFindings?: Set<string>,
): { value?: Roadmap; issues: Issue[] } {
  const issues: Issue[] = [];
  if (!isObject(raw)) {
    error(issues, "schema/type", "roadmap must be a mapping", file);
    return { issues };
  }

  for (const key of Object.keys(raw)) {
    if (!ROADMAP_FIELDS.includes(key as (typeof ROADMAP_FIELDS)[number])) {
      error(issues, "schema/unknown-field", `unknown field "${key}"`, file, undefined, `remove "${key}"`);
    }
  }

  if (raw.version !== 1) {
    error(issues, "schema/version", "unsupported roadmap version; expected 1", file);
  }

  const stepsRaw = raw.steps;
  if (!Array.isArray(stepsRaw)) {
    error(issues, "schema/type", `"steps" must be a list`, file);
    return { issues };
  }
  if (stepsRaw.length > 500) {
    error(issues, "budget/steps", `"steps" has ${stepsRaw.length} items; limit is 500`, file);
  }

  const updated = readString(raw, "updated", 10, issues, file, undefined, false);
  if (updated !== undefined && !isRealDate(updated)) {
    error(issues, "schema/date", `invalid date "${updated}"; expected a real YYYY-MM-DD`, file);
  }
  if (stepsRaw.length > 0 && updated === undefined) {
    error(issues, "schema/missing-field", `missing required field "updated"`, file);
  }

  const steps: Step[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of stepsRaw.entries()) {
    if (!isObject(entry)) {
      error(issues, "schema/type", `steps[${index}] must be a mapping`, file);
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!STEP_FIELDS.includes(key as (typeof STEP_FIELDS)[number])) {
        error(issues, "schema/unknown-field", `unknown field "${key}"`, file, undefined, `remove "${key}"`);
      }
    }

    const id = readString(entry, "id", 32, issues, file, undefined, true);
    if (id !== undefined && !STEP_ID_RE.test(id)) {
      error(issues, "schema/id", `invalid step id "${id}"; expected STEP-001`, file, id);
    }
    if (id !== undefined) {
      if (seen.has(id)) error(issues, "schema/duplicate-id", `duplicate step id "${id}"`, file, id);
      seen.add(id);
    }

    const goal = readString(entry, "goal", 160, issues, file, id, true);
    const why = readString(entry, "why", 200, issues, file, id, true);
    const acceptance = readString(entry, "acceptance", 200, issues, file, id, true);
    const paths = readArray(entry, "paths", 8, 200, issues, file, id, true);
    if (paths) {
      for (const path of paths) {
        if (path.startsWith("/") || path.includes("..")) {
          error(issues, "schema/glob", `"${path}" must be repo-relative and must not contain ".."`, file, id);
        }
      }
    }

    const rawStatus = entry.status;
    let status: StepStatus | undefined;
    if (typeof rawStatus !== "string") {
      error(issues, "schema/missing-field", `missing required field "status"`, file, id);
    } else if (!STATUSES.includes(rawStatus as StepStatus)) {
      error(issues, "schema/status", `invalid status "${rawStatus}"; expected ${STATUSES.join(", ")}`, file, id);
    } else {
      status = rawStatus as StepStatus;
    }

    const evidence = readString(entry, "evidence", 200, issues, file, id, false);
    const blockedBy = readString(entry, "blocked_by", 160, issues, file, id, false);
    const decisions = readArray(entry, "decisions", 8, 32, issues, file, id, false);
    if (decisions) {
      for (const decision of decisions) {
        if (!DECISION_ID_RE.test(decision)) {
          error(issues, "schema/id", `invalid decision id "${decision}"`, file, id);
        } else if (knownDecisions !== undefined && !knownDecisions.has(decision)) {
          error(issues, "roadmap/decision-missing", `decision ${decision} does not exist`, file, id);
        }
      }
    }
    const findings = readArray(entry, "findings", 8, 32, issues, file, id, false);
    if (findings) {
      for (const finding of findings) {
        if (!FINDING_ID_RE.test(finding)) {
          error(issues, "schema/id", `invalid finding id "${finding}"`, file, id);
        } else if (knownFindings !== undefined && !knownFindings.has(finding)) {
          error(issues, "roadmap/finding-missing", `finding ${finding} does not exist`, file, id);
        }
      }
    }

    if (
      status === "done" &&
      (evidence === undefined || /^(todo|tbd|n\/a|none)$/i.test(evidence.trim()))
    ) {
      error(issues, "roadmap/evidence", "done steps require evidence: the test or commit that proves it", file, id);
    }
    if (status === "blocked" && blockedBy === undefined) {
      error(issues, "roadmap/blocked-by", "blocked steps require blocked_by: a step id or the reason", file, id);
    }

    if (id === undefined || goal === undefined || why === undefined || acceptance === undefined || paths === undefined || status === undefined) {
      continue;
    }
    const value: Step = { id, goal, why, paths, acceptance, status };
    if (evidence !== undefined) value.evidence = evidence;
    if (blockedBy !== undefined) value.blocked_by = blockedBy;
    if (decisions && decisions.length > 0) value.decisions = decisions;
    if (findings && findings.length > 0) value.findings = findings;
    steps.push(value);
  }

  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const step of steps) {
    if (step.blocked_by === undefined) continue;
    if (!STEP_ID_RE.test(step.blocked_by)) continue;
    if (!byId.has(step.blocked_by)) {
      error(issues, "roadmap/blocked-by", `blocked_by points at unknown step ${step.blocked_by}`, file, step.id);
    }
  }

  const current = steps.filter((step) => step.status === "current");
  if (current.length > 1) {
    error(
      issues,
      "roadmap/current",
      `${current.length} steps are current: ${current.map((step) => step.id).join(", ")}`,
      file,
      undefined,
      "keep exactly one current step",
    );
  } else if (current.length === 0 && steps.some((step) => step.status === "todo")) {
    warning(issues, "roadmap/no-current", "roadmap has todo steps but no current step", file, undefined, "set one step to status: current");
  }
  for (const step of current) {
    if (step.blocked_by === undefined) continue;
    const blocker = STEP_ID_RE.test(step.blocked_by) ? byId.get(step.blocked_by) : undefined;
    if (blocker === undefined || blocker.status !== "done") {
      error(
        issues,
        "roadmap/current-blocked",
        `current step is blocked by ${blocker?.id ?? `"${step.blocked_by}"`}${
          blocker === undefined ? "" : `, which is ${blocker.status}`
        }`,
        file,
        step.id,
        "clear the blocker or mark the current step blocked",
      );
    }
  }

  if (updated !== undefined && isRealDate(updated) && current.length === 1) {
    const age = Math.floor((Date.now() - Date.parse(`${updated}T00:00:00Z`)) / DAY_MS);
    if (age > STALE_ERROR_DAYS) {
      error(
        issues,
        "roadmap/stale",
        `current step has not moved in ${age} days (updated ${updated})`,
        file,
        current[0]!.id,
        "finish it, split it, or mark it dropped",
      );
    } else if (age > STALE_WARN_DAYS) {
      warning(
        issues,
        "roadmap/stale",
        `current step has not moved in ${age} days (updated ${updated})`,
        file,
        current[0]!.id,
        "finish it, split it, or mark it dropped",
      );
    }
  }

  const value: Roadmap = { version: 1, steps };
  if (updated !== undefined) value.updated = updated;
  return { value, issues };
}

export function loadRoadmap(
  root: string,
  knownDecisions?: Set<string>,
  knownFindings?: Set<string>,
): { roadmap?: Roadmap; issues: Issue[]; file: string } {
  const file = ROADMAP_FILE;
  const path = join(root, file);
  if (!existsSync(path)) return { issues: [], file };

  const safe = safeFile(root, file);
  if (safe === undefined) {
    return {
      issues: [
        {
          severity: "error",
          code: "fs/outside-root",
          message: "roadmap resolves outside the project",
          file,
        },
      ],
      file,
    };
  }

  let raw: unknown;
  try {
    raw = parse(readFileSync(safe, "utf8"));
  } catch (errorValue) {
    return {
      issues: [
        {
          severity: "error",
          code: "yaml/parse",
          message: (errorValue as Error).message.split("\n")[0]!,
          file,
        },
      ],
      file,
    };
  }

  const result = validateRoadmap(raw, file, knownDecisions, knownFindings);
  return {
    ...(result.value === undefined ? {} : { roadmap: result.value }),
    issues: result.issues,
    file,
  };
}

export function stepTokens(step: Step): number {
  return estimateTokens(
    JSON.stringify({
      goal: step.goal,
      why: step.why,
      acceptance: step.acceptance,
      paths: step.paths,
      decisions: step.decisions ?? [],
      findings: step.findings ?? [],
    }),
  );
}
