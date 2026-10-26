import type { Budgets, Config, Decision, Guard, Invariant, Issue, Severity, Status } from "../types.js";
import { isObject } from "../util.js";

export const DECISION_FIELDS = [
  "id",
  "topic",
  "scope",
  "status",
  "created",
  "applies_to",
  "decision",
  "why",
  "rejected",
  "guards",
  "enforced_by",
  "verified_by",
  "supersedes",
  "by",
] as const;

export const GUARD_FIELDS = ["deny", "instead", "check"] as const;
export const INVARIANT_FIELDS = ["id", "rule", "applies_to", "enforced_by"] as const;
export const CONFIG_FIELDS = ["version", "budgets", "advisory_ttl_days"] as const;
export const CONFIG_BUDGET_FIELDS = [
  "context_tokens",
  "decision_tokens",
  "invariants",
  "guards",
] as const;

const ID_RE = /^ADR-[0-9]{4,}$/;
const INVARIANT_ID_RE = /^INV-[0-9]{3,}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const HASH_RE = /^h1:[0-9a-f]{64}$/;
const STATUSES: readonly Status[] = ["active", "rejected", "retired", "draft"];

const BUDGET_BOUNDS: Record<keyof Budgets, readonly [number, number]> = {
  context_tokens: [200, 50_000],
  decision_tokens: [40, 1_000],
  invariants: [1, 25],
  guards: [1, 100],
};

const TTL_BOUNDS: readonly [number, number] = [1, 3_650];

function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

export const DEFAULT_CONFIG: Config = {
  version: 1,
  budgets: {
    context_tokens: 1500,
    decision_tokens: 160,
    invariants: 25,
    guards: 30,
  },
  advisory_ttl_days: 90,
};

function issue(
  issues: Issue[],
  severity: Severity,
  code: string,
  message: string,
  file?: string,
  id?: string,
  fix?: string,
): void {
  const item: Issue = { severity, code, message };
  if (file !== undefined) item.file = file;
  if (id !== undefined) item.id = id;
  if (fix !== undefined) item.fix = fix;
  issues.push(item);
}

function error(
  issues: Issue[],
  code: string,
  message: string,
  file?: string,
  id?: string,
  fix?: string,
): void {
  issue(issues, "error", code, message, file, id, fix);
}

function checkUnknown(
  raw: Record<string, unknown>,
  allowed: readonly string[],
  issues: Issue[],
  file: string,
  id?: string,
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      error(
        issues,
        "schema/unknown-field",
        `unknown field "${key}"`,
        file,
        id,
        `remove "${key}" or move it into a decision record`,
      );
    }
  }
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
  if (value.length === 0) {
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
      "compress it to a single fact",
    );
    return undefined;
  }
  return value;
}

function readStringArray(
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
  if (value.length === 0 && required) {
    error(issues, "schema/empty", `"${key}" must not be empty`, file, id);
    return undefined;
  }
  if (value.length > maxItems) {
    error(
      issues,
      "budget/list-length",
      `"${key}" has ${value.length} items; limit is ${maxItems}`,
      file,
      id,
    );
    return undefined;
  }

  const out: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.length === 0) {
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

function readGuards(
  raw: Record<string, unknown>,
  issues: Issue[],
  file: string,
  id: string | undefined,
): Guard[] | undefined {
  const value = raw.guards;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    error(issues, "schema/type", `"guards" must be a list`, file, id);
    return undefined;
  }
  if (value.length > 3) {
    error(issues, "budget/list-length", `"guards" has ${value.length} items; limit is 3`, file, id);
    return undefined;
  }

  const guards: Guard[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isObject(entry)) {
      error(issues, "schema/type", `"guards[${index}]" must be a mapping`, file, id);
      continue;
    }
    checkUnknown(entry, GUARD_FIELDS, issues, file, id);
    const deny = readString(entry, "deny", 160, issues, file, id, true);
    const instead = readString(entry, "instead", 160, issues, file, id, true);
    const check = readString(entry, "check", 160, issues, file, id, false);
    if (deny === undefined || instead === undefined) continue;
    const guard: Guard = { deny, instead };
    if (check !== undefined) guard.check = check;
    guards.push(guard);
  }
  return guards;
}

function readEnforcedBy(
  raw: Record<string, unknown>,
  issues: Issue[],
  file: string,
  id: string | undefined,
): string | undefined {
  const value = readString(raw, "enforced_by", 200, issues, file, id, false);
  if (value === undefined) return undefined;

  if (value.startsWith("!")) {
    if (value.slice(1).trim().length === 0) {
      error(
        issues,
        "schema/enforced-by",
        `"enforced_by" must name a command after "!"`,
        file,
        id,
      );
      return undefined;
    }
    return value;
  }

  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.includes("..")) {
    error(
      issues,
      "schema/enforced-by",
      `"enforced_by" must be repo-relative and must not contain ".."`,
      file,
      id,
    );
    return undefined;
  }

  return value;
}

export function validateDecision(
  raw: unknown,
  file: string,
): { value?: Decision; issues: Issue[] } {
  const issues: Issue[] = [];
  if (!isObject(raw)) {
    error(issues, "schema/type", "decision record must be a mapping", file);
    return { issues };
  }

  const rawId = typeof raw.id === "string" ? raw.id : undefined;
  checkUnknown(raw, DECISION_FIELDS, issues, file, rawId);

  const id = readString(raw, "id", 32, issues, file, undefined, true);
  if (id !== undefined && !ID_RE.test(id)) {
    error(issues, "schema/id", `invalid id "${id}"; expected ADR-0001`, file, id);
  }

  const topic = readString(raw, "topic", 48, issues, file, id, true);
  if (topic !== undefined && !SLUG_RE.test(topic)) {
    error(issues, "schema/topic", `invalid topic "${topic}"; use lowercase dotted slugs`, file, id);
  }

  const scope = readString(raw, "scope", 32, issues, file, id, true);
  if (scope !== undefined && !SLUG_RE.test(scope)) {
    error(issues, "schema/scope", `invalid scope "${scope}"; use lowercase slugs`, file, id);
  }

  const rawStatus = raw.status;
  let status: Status | undefined;
  if (typeof rawStatus !== "string") {
    error(issues, "schema/missing-field", `missing required field "status"`, file, id);
  } else if (!STATUSES.includes(rawStatus as Status)) {
    error(
      issues,
      "schema/status",
      `invalid status "${rawStatus}"; expected ${STATUSES.join(", ")}`,
      file,
      id,
      "note: superseded is derived, never written",
    );
  } else {
    status = rawStatus as Status;
  }

  const created = readString(raw, "created", 10, issues, file, id, true);
  if (created !== undefined && !isRealDate(created)) {
    error(issues, "schema/date", `invalid date "${created}"; expected a real YYYY-MM-DD`, file, id);
  }

  const appliesTo = readStringArray(raw, "applies_to", 8, 200, issues, file, id, true);
  if (appliesTo) {
    for (const glob of appliesTo) {
      if (glob.startsWith("/") || glob.includes("..")) {
        error(
          issues,
          "schema/glob",
          `"${glob}" must be repo-relative and must not contain ".."`,
          file,
          id,
        );
      }
    }
  }

  const decision = readString(raw, "decision", 200, issues, file, id, true);
  if (decision !== undefined && decision.trim() === "REPLACE_ME") {
    error(issues, "lint/sentinel", "decision still contains the scaffold sentinel", file, id);
  }

  const why = readStringArray(raw, "why", 3, 160, issues, file, id, false);
  const rejected = readStringArray(raw, "rejected", 3, 160, issues, file, id, false);
  const guards = readGuards(raw, issues, file, id);
  const enforcedBy = readEnforcedBy(raw, issues, file, id);
  const verifiedBy = readString(raw, "verified_by", 80, issues, file, id, false);

  if (verifiedBy !== undefined && !HASH_RE.test(verifiedBy)) {
    error(
      issues,
      "schema/fingerprint",
      `invalid verified_by "${verifiedBy}"; expected h1:<64 hex chars>`,
      file,
      id,
      `run: steadfast verify ${id ?? "<id>"}`,
    );
  }

  const supersedes = readStringArray(raw, "supersedes", 8, 32, issues, file, id, false);
  if (supersedes) {
    for (const target of supersedes) {
      if (!ID_RE.test(target)) {
        error(issues, "schema/id", `invalid supersedes target "${target}"`, file, id);
      }
    }
  }

  const rawBy = raw.by;
  let by: "agent" | "human" = "agent";
  if (rawBy !== undefined) {
    if (rawBy !== "agent" && rawBy !== "human") {
      error(issues, "schema/type", `"by" must be "agent" or "human"`, file, id);
    } else {
      by = rawBy;
    }
  }

  if (status === "active" && verifiedBy === undefined) {
    error(
      issues,
      "schema/verified-by",
      "active records require verified_by",
      file,
      id,
      `run: steadfast verify ${id ?? "<id>"}`,
    );
  }

  if ((status === "rejected" || status === "retired") && guards && guards.length > 0) {
    error(
      issues,
      "lint/guard-on-inactive",
      `${status} records cannot impose guards`,
      file,
      id,
      "a rule you no longer follow cannot forbid anything",
    );
  }

  if (status === "rejected" && (why === undefined || why.length === 0)) {
    error(
      issues,
      "schema/rejected-reason",
      "rejected records require why: the reason the proposal was refused",
      file,
      id,
      "a rejection without a reason will be re-litigated",
    );
  }

  if (status === "retired" && (why === undefined || why.length === 0)) {
    error(
      issues,
      "schema/retired-reason",
      "retired records require why: the reason the rule ended",
      file,
      id,
      "a retired rule without a reason is indistinguishable from an oversight",
    );
  }

  if (
    id === undefined ||
    topic === undefined ||
    scope === undefined ||
    status === undefined ||
    created === undefined ||
    appliesTo === undefined ||
    decision === undefined
  ) {
    return { issues };
  }

  const value: Decision = {
    id,
    topic,
    scope,
    status,
    created,
    applies_to: appliesTo,
    decision,
    by,
  };
  if (why && why.length > 0) value.why = why;
  if (rejected && rejected.length > 0) value.rejected = rejected;
  if (guards && guards.length > 0) value.guards = guards;
  if (enforcedBy !== undefined) value.enforced_by = enforcedBy;
  if (verifiedBy !== undefined) value.verified_by = verifiedBy;
  if (supersedes && supersedes.length > 0) value.supersedes = supersedes;

  return { value, issues };
}

export function validateInvariants(
  raw: unknown,
  file: string,
  max: number,
): { values: Invariant[]; issues: Issue[] } {
  const issues: Issue[] = [];
  if (!Array.isArray(raw)) {
    error(issues, "schema/type", "invariants file must be a list", file);
    return { values: [], issues };
  }
  if (raw.length > max) {
    error(
      issues,
      "budget/invariants",
      `${raw.length} invariants exceed the limit of ${max}`,
      file,
      undefined,
      "an invariant that needs company is a decision, not a law",
    );
  }

  const values: Invariant[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of raw.entries()) {
    if (!isObject(entry)) {
      error(issues, "schema/type", `invariants[${index}] must be a mapping`, file);
      continue;
    }
    checkUnknown(entry, INVARIANT_FIELDS, issues, file);
    const id = readString(entry, "id", 32, issues, file, undefined, true);
    if (id !== undefined && !INVARIANT_ID_RE.test(id)) {
      error(issues, "schema/id", `invalid invariant id "${id}"; expected INV-001`, file, id);
    }
    if (id !== undefined) {
      if (seen.has(id)) {
        error(issues, "schema/duplicate-id", `duplicate invariant id "${id}"`, file, id);
      }
      seen.add(id);
    }
    const rule = readString(entry, "rule", 160, issues, file, id, true);
    const appliesTo = readStringArray(entry, "applies_to", 8, 200, issues, file, id, false);
    if (appliesTo) {
      for (const glob of appliesTo) {
        if (glob.startsWith("/") || glob.includes("..")) {
          error(
            issues,
            "schema/glob",
            `"${glob}" must be repo-relative and must not contain ".."`,
            file,
            id,
          );
        }
      }
    }
    const enforcedBy = readEnforcedBy(entry, issues, file, id);
    if (id === undefined || rule === undefined) continue;
    const value: Invariant = { id, rule };
    if (appliesTo && appliesTo.length > 0) value.applies_to = appliesTo;
    if (enforcedBy !== undefined) value.enforced_by = enforcedBy;
    values.push(value);
  }

  return { values, issues };
}

export function validateConfig(raw: unknown, file: string): { value: Config; issues: Issue[] } {
  const issues: Issue[] = [];
  if (!isObject(raw)) {
    error(issues, "schema/type", "config must be a mapping", file);
    return { value: DEFAULT_CONFIG, issues };
  }

  checkUnknown(raw, CONFIG_FIELDS, issues, file);

  if (raw.version !== 1) {
    error(issues, "schema/version", `unsupported config version; expected 1`, file);
  }

  const value: Config = {
    version: 1,
    budgets: { ...DEFAULT_CONFIG.budgets },
    advisory_ttl_days: DEFAULT_CONFIG.advisory_ttl_days,
  };

  if (raw.budgets !== undefined) {
    if (!isObject(raw.budgets)) {
      error(issues, "schema/type", `"budgets" must be a mapping`, file);
    } else {
      checkUnknown(raw.budgets, CONFIG_BUDGET_FIELDS, issues, file);
      for (const key of CONFIG_BUDGET_FIELDS) {
        const entry = raw.budgets[key];
        if (entry === undefined) continue;
        if (typeof entry !== "number" || !Number.isInteger(entry) || entry <= 0) {
          error(issues, "schema/type", `"budgets.${key}" must be a positive integer`, file);
          continue;
        }
        const [min, max] = BUDGET_BOUNDS[key];
        if (entry < min || entry > max) {
          error(
            issues,
            "budget/range",
            `"budgets.${key}" must be between ${min} and ${max}`,
            file,
          );
          continue;
        }
        value.budgets[key] = entry;
      }
    }
  }

  if (raw.advisory_ttl_days !== undefined) {
    const entry = raw.advisory_ttl_days;
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry <= 0) {
      error(issues, "schema/type", `"advisory_ttl_days" must be a positive integer`, file);
    } else if (entry < TTL_BOUNDS[0] || entry > TTL_BOUNDS[1]) {
      error(
        issues,
        "budget/range",
        `"advisory_ttl_days" must be between ${TTL_BOUNDS[0]} and ${TTL_BOUNDS[1]}`,
        file,
      );
    } else {
      value.advisory_ttl_days = entry;
    }
  }

  if (value.budgets.context_tokens < 200) {
    error(issues, "budget/context", "context_tokens must be at least 200", file);
  }

  return { value, issues };
}
