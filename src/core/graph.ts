import type { Decision, Issue, ResolvedStatus } from "../types.js";

export interface Graph {
  resolved: Map<string, ResolvedStatus>;
  supersededBy: Map<string, string>;
  issues: Issue[];
}

export function buildGraph(decisions: Decision[], files: Map<string, string>): Graph {
  const issues: Issue[] = [];
  const byId = new Map<string, Decision>();
  for (const decision of decisions) {
    if (!byId.has(decision.id)) byId.set(decision.id, decision);
  }

  const add = (code: string, message: string, id: string, fix?: string): void => {
    const item: Issue = { severity: "error", code, message, id };
    const file = files.get(id);
    if (file !== undefined) item.file = file;
    if (fix !== undefined) item.fix = fix;
    issues.push(item);
  };

  const supersededBy = new Map<string, string>();
  const edges = new Map<string, string[]>();

  for (const decision of decisions) {
    const targets = decision.supersedes ?? [];
    if (targets.length === 0) continue;

    if (decision.status !== "active") {
      add(
        "graph/inactive-supersede",
        `a ${decision.status} record cannot supersede another record`,
        decision.id,
        "only an active decision can replace an older one",
      );
      continue;
    }

    for (const target of targets) {
      if (target === decision.id) {
        add("graph/self-supersede", "a record cannot supersede itself", decision.id);
        continue;
      }
      const old = byId.get(target);
      if (!old) {
        add(
          "graph/missing-target",
          `supersedes unknown record "${target}"`,
          decision.id,
          `fix the id or remove "${target}" from supersedes`,
        );
        continue;
      }
      if (old.status !== "active") {
        add(
          "graph/inactive-target",
          `cannot supersede "${target}" because it is ${old.status}`,
          decision.id,
          "only active records are in force",
        );
        continue;
      }
      if (old.scope !== decision.scope || old.topic !== decision.topic) {
        add(
          "graph/supersede-mismatch",
          `cannot supersede ${target} (${old.scope}/${old.topic}); this record owns ${decision.scope}/${decision.topic}`,
          decision.id,
          "a successor must replace the same rule",
        );
        continue;
      }
      const existing = supersededBy.get(target);
      if (existing !== undefined) {
        add(
          "graph/double-supersede",
          `"${target}" is already superseded by "${existing}"`,
          decision.id,
          "a record has exactly one successor",
        );
        continue;
      }
      supersededBy.set(target, decision.id);
      const list = edges.get(decision.id) ?? [];
      list.push(target);
      edges.set(decision.id, list);
    }
  }

  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  let cycleReported = false;

  const visit = (id: string): void => {
    const current = state.get(id) ?? 0;
    if (current === 2) return;
    if (current === 1) {
      if (!cycleReported) {
        const start = stack.indexOf(id);
        const cycle = [...stack.slice(start === -1 ? 0 : start), id];
        add(
          "graph/cycle",
          `supersede cycle: ${cycle.join(" -> ")}`,
          id,
          "break the cycle; history is a DAG",
        );
        cycleReported = true;
      }
      return;
    }
    state.set(id, 1);
    stack.push(id);
    for (const next of edges.get(id) ?? []) visit(next);
    stack.pop();
    state.set(id, 2);
  };

  for (const decision of decisions) visit(decision.id);

  const resolved = new Map<string, ResolvedStatus>();
  for (const decision of decisions) {
    resolved.set(decision.id, supersededBy.has(decision.id) ? "superseded" : decision.status);
  }

  const activeTopics = new Map<string, string>();
  for (const decision of decisions) {
    if (resolved.get(decision.id) !== "active") continue;
    const key = `${decision.scope}\u0000${decision.topic}`;
    const other = activeTopics.get(key);
    if (other !== undefined) {
      add(
        "graph/duplicate-topic",
        `two active decisions share scope "${decision.scope}" and topic "${decision.topic}": ${other} and ${decision.id}`,
        decision.id,
        `supersede ${other} instead of adding a parallel rule`,
      );
    } else {
      activeTopics.set(key, decision.id);
    }
  }

  return { resolved, supersededBy, issues };
}
