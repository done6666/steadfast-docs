import type { Decision, Invariant, Issue, ResolvedStatus } from "../types.js";
import { matchGlob, normalizePath, specificity } from "./glob.js";
import { estimateTokens } from "./tokens.js";

export interface PackRequest {
  paths: string[];
  scope?: string;
  budget: number;
  maxGuards: number;
  note?: string;
}

export interface PackResult {
  text: string;
  tokens: number;
  budget: number;
  omitted: number;
  issues: Issue[];
  included: {
    invariants: string[];
    decisions: string[];
    guards: string[];
    rejected: string[];
  };
}

type Kind = "invariant" | "guard" | "decision" | "rejected";

interface Item {
  kind: Kind;
  priority: number;
  rank: number;
  id: string;
  parentId?: string;
  text: string;
}

const PRIORITY: Record<Kind, number> = {
  invariant: 0,
  guard: 1,
  decision: 2,
  rejected: 3,
};

const quote = (value: string): string => JSON.stringify(value);

function matchedPaths(decision: Decision, paths: string[]): string[] {
  if (paths.length === 0) return decision.applies_to;
  return decision.applies_to.filter((glob) => paths.some((path) => matchGlob(path, glob)));
}

export function buildPack(
  decisions: Decision[],
  invariants: Invariant[],
  resolved: Map<string, ResolvedStatus>,
  request: PackRequest,
): PackResult {
  const issues: Issue[] = [];
  const paths = request.paths.map(normalizePath).filter(Boolean);
  const scope = request.scope;

  if (paths.length === 0 && scope === undefined) {
    issues.push({
      severity: "error",
      code: "context/no-selector",
      message: "a context pack needs --for <paths> or --scope <scope>",
      fix: "steadfast context --for src/billing/charge.ts",
    });
    return {
      text: "",
      tokens: 0,
      budget: request.budget,
      omitted: 0,
      issues,
      included: { invariants: [], decisions: [], guards: [], rejected: [] },
    };
  }

  const matches = (decision: Decision): boolean => {
    const scopeHit =
      scope !== undefined && (decision.scope === scope || decision.scope === "global");
    const pathHit = paths.length > 0 && matchedPaths(decision, paths).length > 0;
    return scopeHit || pathHit;
  };

  const rankOf = (decision: Decision): number =>
    Math.max(0, ...matchedPaths(decision, paths).map(specificity));

  const active = decisions
    .filter((decision) => resolved.get(decision.id) === "active" && matches(decision))
    .sort((a, b) => {
      const bySpecificity = rankOf(b) - rankOf(a);
      if (bySpecificity !== 0) return bySpecificity;
      return a.id.localeCompare(b.id);
    });

  const rejected = decisions
    .filter((decision) => resolved.get(decision.id) === "rejected" && matches(decision))
    .sort((a, b) => a.id.localeCompare(b.id));

  const selectedInvariants = invariants.filter((invariant) => {
    if (!invariant.applies_to || invariant.applies_to.length === 0) return true;
    if (paths.length === 0) return true;
    return invariant.applies_to.some((glob) => paths.some((path) => matchGlob(path, glob)));
  });

  const items: Item[] = [];

  for (const invariant of selectedInvariants) {
    items.push({
      kind: "invariant",
      priority: PRIORITY.invariant,
      rank: Number.POSITIVE_INFINITY,
      id: invariant.id,
      text: `  - id: ${invariant.id}\n    rule: ${quote(invariant.rule)}`,
    });
  }

  const guardKeys = new Set<string>();
  let guardCount = 0;

  for (const decision of active) {
    const rank = rankOf(decision);
    const why =
      decision.why && decision.why.length > 0
        ? `\n    why: ${JSON.stringify(decision.why)}`
        : "";
    items.push({
      kind: "decision",
      priority: PRIORITY.decision,
      rank,
      id: decision.id,
      text: `  - id: ${decision.id}\n    scope: ${decision.scope}\n    rule: ${quote(decision.decision)}${why}`,
    });

    for (const guard of decision.guards ?? []) {
      const key = `${guard.deny}\u0000${guard.instead}`;
      if (guardKeys.has(key)) continue;
      guardKeys.add(key);
      if (guardCount >= request.maxGuards) continue;
      guardCount += 1;
      const check = guard.check === undefined ? "" : `\n    check: ${quote(guard.check)}`;
      items.push({
        kind: "guard",
        priority: PRIORITY.guard,
        rank,
        id: `${decision.id}#${guardCount}`,
        parentId: decision.id,
        text: `  - from: ${decision.id}\n    deny: ${quote(guard.deny)}\n    instead: ${quote(guard.instead)}${check}`,
      });
    }
  }

  for (const decision of rejected) {
    const because = decision.why?.[0] ?? "rejected";
    items.push({
      kind: "rejected",
      priority: PRIORITY.rejected,
      rank: rankOf(decision),
      id: decision.id,
      text: `  - id: ${decision.id}\n    proposal: ${quote(decision.decision)}\n    because: ${quote(because)}`,
    });
  }

  const activeById = new Map(active.map((decision) => [decision.id, decision]));
  const droppedGuards = Math.max(0, guardKeys.size - guardCount);

  const header = (tokens: number, omitted: number, over: boolean): string[] => {
    const lines = ["# steadfast context v1"];
    if (paths.length > 0) {
      const shown = paths
        .slice(0, 4)
        .map((path) => (path.length > 60 ? `${path.slice(0, 59)}~` : path));
      const extra = paths.length > 4 ? ` +${paths.length - 4}` : "";
      lines.push(`# paths: ${shown.join(", ")}${extra}`);
    }
    if (scope !== undefined) lines.push(`# scope: ${scope}`);
    lines.push(`# budget: ${tokens}/${request.budget} | omitted: ${omitted}`);
    lines.push("# Read only this output. Do not open .steadfast/ records.");
    if (request.note !== undefined) lines.push(`# note: ${request.note}`);
    if (over) lines.push("# WARNING: invariants alone exceed the budget");
    return lines;
  };

  const render = (chosen: Item[], headerLines: string[]): string => {
    const lines = [...headerLines];
    const sections: Array<[string, Kind]> = [
      ["invariants", "invariant"],
      ["decisions", "decision"],
      ["guards", "guard"],
      ["do_not_revisit", "rejected"],
    ];

    for (const [title, kind] of sections) {
      const group = chosen.filter((item) => item.kind === kind);
      if (group.length === 0) continue;
      lines.push("");
      lines.push(`${title}:`);
      for (const item of group) lines.push(item.text);
    }

    const commands: string[] = [];
    const tests: string[] = [];
    for (const item of chosen) {
      if (item.kind !== "decision") continue;
      const decision = activeById.get(item.id);
      if (decision?.enforced_by === undefined) continue;

      if (decision.enforced_by.startsWith("!")) {
        const command = decision.enforced_by.slice(1).trim();
        if (!commands.includes(command)) commands.push(command);
      } else if (!tests.includes(decision.enforced_by)) {
        tests.push(decision.enforced_by);
      }
    }
    if (commands.length > 0) {
      lines.push("");
      lines.push("verify:");
      for (const command of commands) lines.push(`  - ${quote(command)}`);
    }
    if (tests.length > 0) {
      lines.push("");
      lines.push("tests:");
      for (const test of tests) lines.push(`  - ${quote(test)}`);
    }

    return `${lines.join("\n").trimEnd()}\n`;
  };

  const measure = (chosen: Item[], omitted: number): { text: string; tokens: number } => {
    const body = render(chosen, []);
    let tokens = estimateTokens(body) + 40;
    for (let pass = 0; pass < 2; pass += 1) {
      const text = render(chosen, header(tokens, omitted, tokens > request.budget));
      tokens = estimateTokens(text);
    }
    const text = render(chosen, header(tokens, omitted, tokens > request.budget));
    return { text, tokens: estimateTokens(text) };
  };

  let chosen = [...items];
  let omitted = droppedGuards;
  let result = measure(chosen, omitted);

  while (result.tokens > request.budget) {
    const removable = chosen.filter((item) => item.priority > 0);
    if (removable.length === 0) break;

    const leastImportant = Math.max(...removable.map((item) => item.priority));
    const pool = removable
      .filter((item) => item.priority === leastImportant)
      .sort((a, b) => a.rank - b.rank || b.id.localeCompare(a.id));

    const victim = pool[0];
    if (victim === undefined) break;

    let next = chosen.filter((item) => item !== victim);
    omitted += 1;

    if (victim.kind === "decision") {
      const orphans = next.filter(
        (item) => item.kind === "guard" && item.parentId === victim.id,
      );
      next = next.filter((item) => !(item.kind === "guard" && item.parentId === victim.id));
      omitted += orphans.length;
    }

    chosen = next;
    result = measure(chosen, omitted);
  }

  if (result.tokens > request.budget) {
    issues.push({
      severity: "error",
      code: "context/over-budget",
      message: `invariants alone need ${result.tokens} tokens; the budget is ${request.budget}`,
      fix: "raise budgets.context_tokens or cut invariants",
    });
  }

  const included = {
    invariants: chosen.filter((item) => item.kind === "invariant").map((item) => item.id),
    decisions: chosen.filter((item) => item.kind === "decision").map((item) => item.id),
    guards: chosen.filter((item) => item.kind === "guard").map((item) => item.id),
    rejected: chosen.filter((item) => item.kind === "rejected").map((item) => item.id),
  };

  return {
    text: result.text,
    tokens: result.tokens,
    budget: request.budget,
    omitted,
    issues,
    included,
  };
}
