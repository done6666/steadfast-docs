import { statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { listRepoFiles } from "../core/fingerprint.js";
import { matchGlob, normalizePath } from "../core/glob.js";
import { buildGraph } from "../core/graph.js";
import { buildPack } from "../core/pack.js";
import { insideRoot } from "../core/paths.js";
import { loadProject } from "../core/store.js";
import { BUDGET_BOUNDS } from "../core/validate.js";
import type { Decision, ResolvedStatus } from "../types.js";
import { write, writeError } from "../output.js";
import { resolveExistingRoot } from "./shared.js";

interface Selectors {
  paths: string[];
  matchPaths: string[];
  warnings: string[];
}

/**
 * A selector may be a file, a directory or a glob. Directories and globs
 * expand to the files they cover, so a rule for `src/core/pack.ts` is found
 * when the agent passes `src/core`.
 */
function resolveSelectors(
  root: string,
  values: string[],
  decisions: Decision[],
  resolved: Map<string, ResolvedStatus>,
): Selectors {
  const paths = [
    ...new Set(
      values
        .map((value) => {
          const normalized = normalizePath(value.trim())
            .replace(/\/+/g, "/")
            .replace(/\/+$/, "");
          return normalized.length === 0 || normalized === "." ? "." : normalized;
        })
        .filter(Boolean),
    ),
  ];
  if (paths.length === 0) return { paths, matchPaths: [], warnings: [] };

  let files: string[] | undefined;
  const repoFiles = (): string[] => (files ??= listRepoFiles(root));
  const matchPaths: string[] = [];
  const warnings: string[] = [];

  for (const selector of paths) {
    const isGlob = /[*?]/.test(selector);
    const targets = new Set<string>(isGlob ? [] : [selector]);
    const absolute = join(root, selector);
    let isDirectory = false;
    try {
      isDirectory = statSync(absolute).isDirectory() && insideRoot(root, absolute);
    } catch {
      // A missing path is a legitimate new file; match it literally.
    }

    let expandedFiles = 0;
    if (isDirectory) {
      const prefix = selector === "." ? "" : `${selector}/`;
      for (const file of repoFiles()) {
        if (file.startsWith(prefix)) {
          targets.add(file);
          expandedFiles += 1;
        }
      }
    } else if (isGlob) {
      for (const file of repoFiles()) {
        if (matchGlob(file, selector)) {
          targets.add(file);
          expandedFiles += 1;
        }
      }
    }

    const covered = [...targets];
    matchPaths.push(...covered);

    const coveredSet = new Set(covered);
    const relevant = decisions.filter((decision) => {
      const status = resolved.get(decision.id);
      return status === "active" || status === "rejected";
    });
    const globHits = new Map<string, boolean>();
    for (const glob of new Set(relevant.flatMap((decision) => decision.applies_to))) {
      const normalized = normalizePath(glob).replace(/\/+/g, "/").replace(/\/+$/, "");
      globHits.set(
        glob,
        /[*?]/.test(normalized)
          ? covered.some((path) => matchGlob(path, normalized))
          : coveredSet.has(normalized),
      );
    }
    const hit = relevant.some((decision) =>
      decision.applies_to.some((glob) => globHits.get(glob) === true),
    );
    if (!hit) {
      warnings.push(
        expandedFiles === 0 && (isDirectory || /[*?]/.test(selector))
          ? `selector matched no tracked files: "${selector}"`
          : `no decision matches "${selector}"`,
      );
    }
  }

  return { paths, matchPaths: [...new Set(matchPaths)], warnings };
}

export async function contextCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      for: { type: "string", multiple: true },
      scope: { type: "string" },
      budget: { type: "string" },
      strict: { type: "boolean", default: false },
      "allow-partial": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  if (values.help) {
    write("steadfast context --for <path[,path]> [--scope <scope>] [--budget <tokens>]");
    write("");
    write("  Compiles the token-budgeted memory pack an agent is allowed to read.");
    write("  --for     repo-relative files, directories or globs; repeatable or comma-separated");
    write("  --scope   include every record in this scope (global records apply)");
    write("  --budget  override config budget (lower only)");
    write("  --strict  fail when a selector matches no decision or no files");
    write("  --allow-partial  print a pack even when budget forces records out; ask the human first");
    write("  --json    machine-readable envelope");
    return 0;
  }

  const root = resolveExistingRoot(values.root);
  if (root === undefined) {
    writeError("error: not a steadfast project (no .steadfast directory); run: steadfast init");
    return 2;
  }

  const loaded = loadProject(root);
  const graph = buildGraph(loaded.decisions, loaded.files);

  const errors = [...loaded.issues, ...graph.issues].filter(
    (issue) => issue.severity === "error",
  );
  if (errors.length > 0) {
    for (const issue of errors) {
      writeError(`error: ${issue.code}: ${issue.message}`);
      if (issue.fix !== undefined) writeError(`  fix: ${issue.fix}`);
    }
    writeError("memory has errors; run: steadfast check");
    return 2;
  }

  const paths = (values.for ?? [])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);

  const outside = paths.find(
    (path) =>
      path.startsWith("/") ||
      path.startsWith("\\") ||
      /^[A-Za-z]:/.test(path) ||
      path.split(/[\\/]/).includes(".."),
  );
  if (outside !== undefined) {
    writeError(`error: selectors must stay inside the project: ${outside}`);
    return 2;
  }

  const budget =
    values.budget === undefined ? loaded.config.budgets.context_tokens : Number(values.budget);
  if (!Number.isFinite(budget) || budget <= 0) {
    writeError(`error: invalid --budget "${values.budget}"`);
    return 2;
  }
  if (values.budget !== undefined && budget > loaded.config.budgets.context_tokens) {
    writeError(
      `error: --budget (${budget}) cannot exceed budgets.context_tokens (${loaded.config.budgets.context_tokens})`,
    );
    writeError("  ask the human to raise the config, or pass a lower value");
    return 2;
  }

  const selectors = resolveSelectors(root, paths, loaded.decisions, graph.resolved);
  const warnings = selectors.warnings.slice(0, 3);
  if (selectors.warnings.length > warnings.length) {
    warnings.push(
      `${selectors.warnings.length - warnings.length} more selector(s) matched nothing`,
    );
  }

  const pack = buildPack(loaded.decisions, loaded.invariants, graph.resolved, {
    paths: selectors.paths,
    matchPaths: selectors.matchPaths,
    warnings,
    scope: values.scope,
    budget,
    maxGuards: loaded.config.budgets.guards,
  });

  if (pack.issues.some((issue) => issue.severity === "error")) {
    for (const issue of pack.issues) {
      if (issue.severity !== "error") continue;
      writeError(`error: ${issue.message}`);
      if (issue.fix !== undefined) writeError(`  fix: ${issue.fix}`);
    }
    for (const issue of pack.issues) {
      if (issue.severity === "warning") writeError(`warning: ${issue.message}`);
    }
    return 2;
  }

  if (pack.omitted > 0 && values["allow-partial"] !== true) {
    const reasons: string[] = [];
    const tokenShort = pack.omittedByBudget > 0 || pack.requiredTokens > pack.budget;
    if (tokenShort) {
      reasons.push(
        pack.omittedByBudget > 0
          ? `${pack.omittedByBudget} item(s) omitted by the token budget (need ~${pack.requiredTokens}, budget ${pack.budget})`
          : `the complete pack needs ~${pack.requiredTokens} tokens (budget ${pack.budget})`,
      );
    }
    if (pack.omittedGuards > 0) {
      reasons.push(
        `${pack.omittedGuards} guard(s) omitted by budgets.guards (limit ${pack.guardLimit}, need ${pack.requiredGuards})`,
      );
    }
    writeError(`error: context pack is incomplete: ${reasons.join("; ")}`);

    const tokenMax = BUDGET_BOUNDS.context_tokens[1];
    const tokenMin = BUDGET_BOUNDS.context_tokens[0];
    const configured = loaded.config.budgets.context_tokens;
    if (tokenShort) {
      if (pack.requiredTokens > tokenMax) {
        writeError(
          `  narrow --for; budgets.context_tokens is capped at ${tokenMax} and this pack needs ~${pack.requiredTokens}`,
        );
      } else if (values.budget !== undefined) {
        writeError(
          `  re-run without --budget (configured ${configured}), or ask the human to raise budgets.context_tokens to ~${Math.max(tokenMin, pack.requiredTokens)}`,
        );
      } else {
        writeError(
          `  narrow --for, or ask the human to raise budgets.context_tokens to ~${Math.max(tokenMin, pack.requiredTokens)}`,
        );
      }
    }

    const guardMax = BUDGET_BOUNDS.guards[1];
    if (pack.omittedGuards > 0) {
      if (pack.requiredGuards > guardMax) {
        writeError(
          `  narrow --for; budgets.guards is capped at ${guardMax} and this pack needs ${pack.requiredGuards}`,
        );
      } else {
        writeError(
          `  narrow --for, or ask the human to raise budgets.guards to ${pack.requiredGuards}`,
        );
      }
    }
    writeError(
      "  do not change the budget or pass --allow-partial without the human's approval",
    );
    return 2;
  }

  if (values.strict && selectors.warnings.length > 0) {
    for (const warning of selectors.warnings) writeError(`warning: ${warning}`);
    writeError("strict: every selector must match at least one decision");
    return 2;
  }

  if (values.json) {
    write(
      JSON.stringify(
        {
          tokens: pack.tokens,
          budget: pack.budget,
          omitted: pack.omitted,
          omittedByBudget: pack.omittedByBudget,
          omittedGuards: pack.omittedGuards,
          requiredTokens: pack.requiredTokens,
          requiredGuards: pack.requiredGuards,
          guardLimit: pack.guardLimit,
          warnings: selectors.warnings,
          included: pack.included,
          text: pack.text,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  write(pack.text.trimEnd());
  return 0;
}
