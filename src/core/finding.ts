import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";
import type {
  Confidence,
  Finding,
  FindingStatus,
  Issue,
  ResolvedFindingStatus,
} from "../types.js";
import { estimateTokens } from "./tokens.js";
import { insideRoot, safeFile } from "./paths.js";
import { isObject } from "../util.js";

export const FINDING_FIELDS = [
  "id",
  "topic",
  "scope",
  "status",
  "target",
  "claim",
  "evidence",
  "confidence",
  "observed_at",
  "applies_to",
  "why",
  "supersedes",
  "by",
] as const;

const FINDING_ID_RE = /^FIND-[0-9]{4,}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const STATUSES: readonly FindingStatus[] = ["active", "retracted", "retired"];
const CONFIDENCES: readonly Confidence[] = ["high", "medium", "low"];
const DAY_MS = 86_400_000;

function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function issue(
  issues: Issue[],
  severity: "error" | "warning",
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
    if (required) issue(issues, "error", "schema/missing-field", `missing required field "${key}"`, file, id);
    return undefined;
  }
  if (typeof value !== "string") {
    issue(issues, "error", "schema/type", `"${key}" must be a string`, file, id);
    return undefined;
  }
  if (value.trim().length === 0) {
    issue(issues, "error", "schema/empty", `"${key}" must not be empty`, file, id);
    return undefined;
  }
  if (value.length > max) {
    issue(issues, "error", "budget/field-length", `"${key}" is ${value.length} chars; limit is ${max}`, file, id);
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
    if (required) issue(issues, "error", "schema/missing-field", `missing required field "${key}"`, file, id);
    return undefined;
  }
  if (!Array.isArray(value)) {
    issue(issues, "error", "schema/type", `"${key}" must be a list`, file, id);
    return undefined;
  }
  if (required && value.length === 0) {
    issue(issues, "error", "schema/empty", `"${key}" must not be empty`, file, id);
    return undefined;
  }
  if (value.length > maxItems) {
    issue(issues, "error", "budget/list-length", `"${key}" has ${value.length} items; limit is ${maxItems}`, file, id);
    return undefined;
  }
  const out: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim().length === 0) {
      issue(issues, "error", "schema/type", `"${key}[${index}]" must be a non-empty string`, file, id);
      continue;
    }
    if (item.length > maxLength) {
      issue(issues, "error", "budget/field-length", `"${key}[${index}]" is ${item.length} chars; limit is ${maxLength}`, file, id);
      continue;
    }
    out.push(item);
  }
  if (required && out.length === 0) {
    issue(issues, "error", "schema/empty", `"${key}" must contain at least one valid entry`, file, id);
    return undefined;
  }
  return out;
}

export function validateFinding(
  raw: unknown,
  file: string,
): { value?: Finding; issues: Issue[] } {
  const issues: Issue[] = [];
  if (!isObject(raw)) {
    issue(issues, "error", "schema/type", "finding must be a mapping", file);
    return { issues };
  }

  for (const key of Object.keys(raw)) {
    if (!FINDING_FIELDS.includes(key as (typeof FINDING_FIELDS)[number])) {
      issue(issues, "error", "schema/unknown-field", `unknown field "${key}"`, file, undefined, `remove "${key}"`);
    }
  }

  const id = readString(raw, "id", 32, issues, file, undefined, true);
  if (id !== undefined && !FINDING_ID_RE.test(id)) {
    issue(issues, "error", "schema/id", `invalid id "${id}"; expected FIND-0001`, file, id);
  }

  const topic = readString(raw, "topic", 48, issues, file, id, true);
  if (topic !== undefined && !SLUG_RE.test(topic)) {
    issue(issues, "error", "schema/topic", `invalid topic "${topic}"; use lowercase dotted slugs`, file, id);
  }
  const scope = readString(raw, "scope", 32, issues, file, id, true);
  if (scope !== undefined && !SLUG_RE.test(scope)) {
    issue(issues, "error", "schema/scope", `invalid scope "${scope}"; use lowercase slugs`, file, id);
  }

  const rawStatus = raw.status;
  let status: FindingStatus | undefined;
  if (typeof rawStatus !== "string") {
    issue(issues, "error", "schema/missing-field", `missing required field "status"`, file, id);
  } else if (!STATUSES.includes(rawStatus as FindingStatus)) {
    issue(issues, "error", "schema/status", `invalid status "${rawStatus}"; expected ${STATUSES.join(", ")}`, file, id);
  } else {
    status = rawStatus as FindingStatus;
  }

  const target = readString(raw, "target", 160, issues, file, id, true);
  const claim = readString(raw, "claim", 200, issues, file, id, true);
  const evidence = readString(raw, "evidence", 200, issues, file, id, true);
  if (evidence !== undefined && !evidence.startsWith("!")) {
    if (evidence.startsWith("/") || /^[A-Za-z]:[\\/]/.test(evidence) || evidence.includes("..")) {
      issue(issues, "error", "schema/evidence", `"evidence" must be repo-relative and must not contain ".."`, file, id);
    }
  }
  if (evidence !== undefined && evidence.startsWith("!") && evidence.slice(1).trim().length === 0) {
    issue(issues, "error", "schema/evidence", `"evidence" must name a command after "!"`, file, id);
  }

  const rawConfidence = raw.confidence;
  let confidence: Confidence | undefined;
  if (typeof rawConfidence !== "string" || !CONFIDENCES.includes(rawConfidence as Confidence)) {
    issue(issues, "error", "schema/confidence", `"confidence" must be high, medium or low`, file, id);
  } else {
    confidence = rawConfidence as Confidence;
  }

  const observedAt = readString(raw, "observed_at", 10, issues, file, id, true);
  if (observedAt !== undefined && !isRealDate(observedAt)) {
    issue(issues, "error", "schema/date", `invalid date "${observedAt}"; expected a real YYYY-MM-DD`, file, id);
  }

  const appliesTo = readArray(raw, "applies_to", 8, 200, issues, file, id, true);
  if (appliesTo) {
    for (const glob of appliesTo) {
      if (glob.startsWith("/") || glob.includes("..")) {
        issue(issues, "error", "schema/glob", `"${glob}" must be repo-relative and must not contain ".."`, file, id);
      }
    }
  }

  const why = readArray(raw, "why", 3, 160, issues, file, id, false);
  if (status === "retracted" && (why === undefined || why.length === 0)) {
    issue(issues, "error", "schema/retracted-reason", "retracted findings require why: the reason the claim is false", file, id);
  }

  const supersedes = readArray(raw, "supersedes", 8, 32, issues, file, id, false);
  if (supersedes) {
    for (const targetId of supersedes) {
      if (!FINDING_ID_RE.test(targetId)) {
        issue(issues, "error", "schema/id", `invalid supersedes target "${targetId}"`, file, id);
      }
    }
  }

  const rawBy = raw.by;
  let by: "agent" | "human" = "agent";
  if (rawBy !== undefined) {
    if (rawBy !== "agent" && rawBy !== "human") {
      issue(issues, "error", "schema/type", `"by" must be "agent" or "human"`, file, id);
    } else {
      by = rawBy;
    }
  }

  if (
    id === undefined ||
    topic === undefined ||
    scope === undefined ||
    status === undefined ||
    target === undefined ||
    claim === undefined ||
    evidence === undefined ||
    confidence === undefined ||
    observedAt === undefined ||
    appliesTo === undefined
  ) {
    return { issues };
  }

  const value: Finding = {
    id,
    topic,
    scope,
    status,
    target,
    claim,
    evidence,
    confidence,
    observed_at: observedAt,
    applies_to: appliesTo,
    by,
  };
  if (why && why.length > 0) value.why = why;
  if (supersedes && supersedes.length > 0) value.supersedes = supersedes;
  return { value, issues };
}

export function loadFindings(root: string): {
  findings: Finding[];
  files: Map<string, string>;
  issues: Issue[];
} {
  const issues: Issue[] = [];
  const dir = join(root, ".steadfast", "findings");
  const findings: Finding[] = [];
  const files = new Map<string, string>();
  if (!existsSync(dir)) return { findings, files, issues };
  if (!insideRoot(root, dir)) {
    issue(issues, "error", "fs/outside-root", ".steadfast/findings resolves outside the project", ".steadfast/findings");
    return { findings, files, issues };
  }

  const names = readdirSync(dir, { recursive: true })
    .filter((name): name is string => typeof name === "string")
    .filter((name) => /\.ya?ml$/.test(name))
    .filter((name) => !name.split(/[\\/]/).some((part) => part.startsWith("_")))
    .sort();

  for (const name of names) {
    const absolute = join(dir, name);
    const relativePath = relative(root, absolute).replace(/\\/g, "/");
    const safe = safeFile(root, relativePath);
    if (safe === undefined) {
      issue(issues, "error", "fs/outside-root", "finding resolves outside the project", relativePath);
      continue;
    }
    let raw: unknown;
    try {
      raw = parse(readFileSync(safe, "utf8"));
    } catch (errorValue) {
      issue(issues, "error", "yaml/parse", (errorValue as Error).message.split("\n")[0]!, relativePath);
      continue;
    }
    const result = validateFinding(raw, relativePath);
    issues.push(...result.issues);
    if (result.value === undefined) continue;
    if (files.has(result.value.id)) {
      issue(
        issues,
        "error",
        "schema/duplicate-id",
        `duplicate finding id "${result.value.id}" (also in ${files.get(result.value.id)})`,
        relativePath,
        result.value.id,
      );
      continue;
    }
    files.set(result.value.id, relativePath);
    findings.push(result.value);
  }

  return { findings, files, issues };
}

export interface FindingGraph {
  resolved: Map<string, ResolvedFindingStatus>;
  supersededBy: Map<string, string>;
  issues: Issue[];
}

export function buildFindingGraph(
  findings: Finding[],
  files: Map<string, string>,
): FindingGraph {
  const issues: Issue[] = [];
  const resolved = new Map<string, ResolvedFindingStatus>();
  const supersededBy = new Map<string, string>();
  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  const fileOf = (finding: Finding): string =>
    files.get(finding.id) ?? `.steadfast/findings/${finding.id}.yaml`;

  for (const finding of findings) {
    resolved.set(finding.id, finding.status);
  }

  for (const finding of findings) {
    for (const targetId of finding.supersedes ?? []) {
      const old = byId.get(targetId);
      if (old === undefined) {
        issue(
          issues,
          "error",
          "graph/missing-target",
          `supersedes target "${targetId}" does not exist`,
          fileOf(finding),
          finding.id,
        );
        continue;
      }
      if (targetId === finding.id) {
        issue(issues, "error", "graph/self-supersede", "a finding cannot supersede itself", fileOf(finding), finding.id);
        continue;
      }
      if (old.scope !== finding.scope || old.topic !== finding.topic) {
        issue(
          issues,
          "error",
          "graph/replacement",
          `a successor must keep the same scope and topic as ${targetId}`,
          fileOf(finding),
          finding.id,
        );
      }
      if (old.status !== "active") {
        issue(
          issues,
          "error",
          "graph/supersede-inactive",
          `cannot supersede ${targetId}; it is ${resolved.get(targetId) ?? old.status}`,
          fileOf(finding),
          finding.id,
        );
      }
      const existing = supersededBy.get(targetId);
      if (existing !== undefined) {
        issue(
          issues,
          "error",
          "graph/double-supersede",
          `${targetId} already has successor ${existing}`,
          fileOf(finding),
          finding.id,
        );
      } else {
        supersededBy.set(targetId, finding.id);
      }
    }
  }

  const state = new Map<string, "visiting" | "done">();
  const reported = new Set<string>();
  const visit = (id: string, path: string[]): void => {
    const current = state.get(id);
    if (current === "done") return;
    if (current === "visiting") {
      const start = path.indexOf(id);
      const cycle = [...path.slice(start), id];
      const key = [...cycle].sort().join(",");
      if (!reported.has(key)) {
        reported.add(key);
        issue(
          issues,
          "error",
          "graph/cycle",
          `supersede cycle: ${cycle.join(" -> ")}`,
          fileOf(byId.get(id)!),
          id,
        );
      }
      return;
    }
    state.set(id, "visiting");
    for (const targetId of byId.get(id)?.supersedes ?? []) {
      if (byId.has(targetId)) visit(targetId, [...path, id]);
    }
    state.set(id, "done");
  };
  for (const finding of findings) visit(finding.id, []);

  for (const finding of findings) {
    if (supersededBy.has(finding.id)) resolved.set(finding.id, "superseded");
  }

  const active = findings.filter((finding) => resolved.get(finding.id) === "active");
  const seen = new Map<string, string>();
  for (const finding of active) {
    const key = `${finding.scope}\u0000${finding.topic}\u0000${finding.target}`;
    const other = seen.get(key);
    if (other !== undefined) {
      issue(
        issues,
        "error",
        "graph/duplicate-finding",
        `active finding ${other} already covers ${finding.scope}/${finding.topic}@${finding.target}`,
        fileOf(finding),
        finding.id,
        `supersede ${other} instead`,
      );
    } else {
      seen.set(key, finding.id);
    }
  }

  return { resolved, supersededBy, issues };
}

export function findingTokens(finding: Finding): number {
  return estimateTokens(
    JSON.stringify({
      target: finding.target,
      claim: finding.claim,
      evidence: finding.evidence,
      confidence: finding.confidence,
    }),
  );
}

export function staleFindingAge(
  finding: Finding,
  ttlDays: number,
  now = Date.now(),
): number | undefined {
  if (finding.status !== "active") return undefined;
  const observed = Date.parse(`${finding.observed_at}T00:00:00Z`);
  if (!Number.isFinite(observed)) return undefined;
  const age = Math.floor((now - observed) / DAY_MS);
  return age > ttlDays ? age : undefined;
}
