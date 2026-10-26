import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { FileIndex } from "./fingerprint.js";
import { buildGraph } from "./graph.js";
import { acquireLock } from "./lock.js";
import { insideRoot, safeFile } from "./paths.js";
import { loadProject } from "./store.js";
import { recordTokens } from "./tokens.js";
import { validateDecision } from "./validate.js";
import type { Guard } from "../types.js";
import { today } from "../util.js";

const SLUG = /^[a-z0-9][a-z0-9._-]*$/;
const STATUSES = new Set(["active", "rejected", "retired", "draft"]);

export interface CreateDecisionOptions {
  scope: string;
  topic: string;
  decision: string;
  why?: string[];
  rejected?: string[];
  guards?: Guard[];
  status?: string;
  appliesTo?: string[];
  supersedes?: string[];
  enforcedBy?: string;
}

export interface CreateDecisionResult {
  ok: boolean;
  id?: string;
  path?: string;
  status?: string;
  appliesTo?: string[];
  enforcedBy?: string;
  messages: string[];
  exitCode: number;
}

export function createDecision(
  root: string,
  options: CreateDecisionOptions,
): CreateDecisionResult {
  const messages: string[] = [];
  const fail = (message: string): CreateDecisionResult => ({
    ok: false,
    messages: [...messages, message],
    exitCode: 2,
  });

  const scope = options.scope;
  const topic = options.topic;
  const status = options.status ?? "draft";
  const decision = options.decision;
  const why = (options.why ?? []).map((value) => value.trim()).filter(Boolean);

  if (scope.length === 0 || topic.length === 0) {
    return fail("error: --scope and --topic are required");
  }
  if (!SLUG.test(scope) || !SLUG.test(topic)) {
    return fail("error: scope and topic must be lowercase slugs (a-z, 0-9, . _ -)");
  }
  if (!STATUSES.has(status)) {
    return fail(`error: invalid status "${status}"`);
  }
  if (decision.trim().length === 0) {
    return fail("error: every record needs --decision");
  }
  if (status === "rejected" && why.length === 0) {
    return fail("error: a rejected record needs --why (the reason it was refused)");
  }
  if (status === "retired" && why.length === 0) {
    return fail("error: a retired record needs --why (the reason the rule ended)");
  }

  const decisionsDir = join(root, ".steadfast", "decisions");
  mkdirSync(decisionsDir, { recursive: true });
  if (!insideRoot(root, decisionsDir)) {
    return fail("error: .steadfast/decisions resolves outside the project");
  }

  let release: (() => void) | undefined;
  try {
    release = acquireLock(join(decisionsDir, ".lock"));
  } catch (error) {
    return fail(`error: ${(error as Error).message}`);
  }

  try {
    const loaded = loadProject(root);
    if (
      loaded.issues.some(
        (issue) => issue.severity === "error" && issue.code === "project/no-config",
      )
    ) {
      return fail("error: .steadfast/config.yaml is missing; run: steadfast init");
    }
    if (loaded.issues.some((issue) => issue.code === "fs/outside-root")) {
      return fail("error: .steadfast resolves outside the project; refusing to write");
    }

    const graph = buildGraph(loaded.decisions, loaded.files);
    const supersedes = [
      ...new Set(
        (options.supersedes ?? [])
          .flatMap((value) => value.split(","))
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];

    for (const target of supersedes) {
      const old = loaded.decisions.find((entry) => entry.id === target);
      if (old === undefined) {
        return fail(`error: cannot supersede unknown record "${target}"`);
      }
      if (old.status !== "active" || graph.resolved.get(target) !== "active") {
        return fail(
          `error: cannot supersede ${target}; it is ${graph.resolved.get(target) ?? old.status}`,
        );
      }
      if (old.scope !== scope || old.topic !== topic) {
        return fail(
          `error: ${target} owns ${old.scope}/${old.topic}, not ${scope}/${topic}\n  a successor must replace the same rule`,
        );
      }
    }

    if (supersedes.length > 0 && status !== "active") {
      return fail("error: only active records can supersede");
    }

    const conflict = loaded.decisions.find(
      (entry) =>
        graph.resolved.get(entry.id) === "active" &&
        entry.scope === scope &&
        entry.topic === topic &&
        !supersedes.includes(entry.id),
    );
    if (conflict !== undefined) {
      return fail(
        `error: active decision ${conflict.id} already owns ${scope}/${topic}; supersede it instead\n  fix: steadfast new --scope ${scope} --topic ${topic} --supersedes ${conflict.id} --status active --decision "<rule>"`,
      );
    }

    const existing = existsSync(decisionsDir) ? readdirSync(decisionsDir, { recursive: true }) : [];
    const fileNumbers = existing
      .map((name) => /(?:^|[\\/])ADR-(\d+)\.ya?ml$/.exec(String(name))?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number);
    const loadedNumbers = loaded.decisions
      .map((entry) => Number(entry.id.slice(4)))
      .filter((value) => Number.isFinite(value));
    const highest = Math.max(0, ...fileNumbers, ...loadedNumbers);

    const predecessor =
      supersedes.length === 1
        ? loaded.decisions.find((entry) => entry.id === supersedes[0])
        : undefined;
    const appliesTo = (options.appliesTo ?? [])
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean);
    if (appliesTo.length === 0) {
      if (predecessor !== undefined) {
        appliesTo.push(...predecessor.applies_to);
      } else {
        appliesTo.push(scope === "global" ? "**" : `${scope}/**`);
      }
    }

    const enforcedBy = options.enforcedBy ?? predecessor?.enforced_by;
    const rejected = options.rejected ?? predecessor?.rejected;
    const guards = options.guards ?? predecessor?.guards;
    const base: Record<string, unknown> = {
      topic,
      scope,
      status,
      created: today(),
      applies_to: appliesTo,
      decision,
    };
    if (why.length > 0) base.why = why;
    if (rejected !== undefined && rejected.length > 0) {
      base.rejected = rejected;
    }
    if (guards !== undefined && guards.length > 0) {
      base.guards = guards;
    }
    if (enforcedBy !== undefined) base.enforced_by = enforcedBy;
    if (status === "active") base.verified_by = new FileIndex(root).fingerprint(appliesTo);
    if (supersedes.length > 0) base.supersedes = supersedes;
    base.by = "agent";

    let id = "";
    let path = "";
    let wrote = false;
    for (let offset = 0; offset < 100; offset += 1) {
      id = `ADR-${String(highest + 1 + offset).padStart(4, "0")}`;
      path = join(decisionsDir, `${id}.yaml`);
      const record = { id, ...base };

      const validation = validateDecision(record, `.steadfast/decisions/${id}.yaml`);
      const validationErrors = validation.issues.filter(
        (issue) => issue.severity === "error",
      );
      if (validationErrors.length > 0) {
        return {
          ok: false,
          messages: validationErrors.flatMap((issue) => [
            `error: ${issue.code}: ${issue.message}`,
            ...(issue.fix === undefined ? [] : [`  fix: ${issue.fix}`]),
          ]),
          exitCode: 2,
        };
      }

      const value = validation.value;
      if (value !== undefined) {
        if (status === "active") {
          const tokens = recordTokens(value);
          if (tokens > loaded.config.budgets.decision_tokens) {
            return fail(
              `error: record is ${tokens} tokens; the limit is ${loaded.config.budgets.decision_tokens}`,
            );
          }
          if (
            value.enforced_by !== undefined &&
            !value.enforced_by.startsWith("!") &&
            safeFile(root, value.enforced_by) === undefined
          ) {
            return fail(
              `error: enforced_by does not resolve to a file inside the project: ${value.enforced_by}`,
            );
          }
        }
        if ((status === "rejected" || status === "retired") && value.enforced_by !== undefined) {
          return fail(`error: ${status} records cannot be enforced`);
        }
      }

      try {
        writeFileSync(path, stringify(record, { lineWidth: 0 }), { flag: "wx" });
        wrote = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }

    if (!wrote) {
      return fail("error: could not allocate a decision id after 100 attempts");
    }

    if (status === "active") {
      const refreshed = loadProject(root);
      const refreshedGraph = buildGraph(refreshed.decisions, refreshed.files);
      const rival = refreshed.decisions.find(
        (entry) =>
          entry.id !== id &&
          refreshedGraph.resolved.get(entry.id) === "active" &&
          entry.scope === scope &&
          entry.topic === topic,
      );
      if (rival !== undefined && rival.id < id) {
        unlinkSync(path);
        return fail(
          `error: another active record (${rival.id}) claimed ${scope}/${topic} first`,
        );
      }
    }

    const after = loadProject(root);
    const afterGraph = buildGraph(after.decisions, after.files);
    const own = [...after.issues, ...afterGraph.issues].filter(
      (issue) =>
        issue.id === id &&
        issue.severity === "error" &&
        issue.code !== "graph/duplicate-topic",
    );
    if (own.length > 0) {
      unlinkSync(path);
      return {
        ok: false,
        messages: own.map((issue) => `error: ${issue.code}: ${issue.message}`),
        exitCode: 2,
      };
    }

    return {
      ok: true,
      id,
      path: `.steadfast/decisions/${id}.yaml`,
      status,
      appliesTo,
      ...(enforcedBy === undefined ? {} : { enforcedBy }),
      messages: [],
      exitCode: 0,
    };
  } finally {
    release?.();
  }
}
