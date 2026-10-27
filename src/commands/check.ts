import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import { FileIndex, listRepoFiles } from "../core/fingerprint.js";
import {
  changedEntries,
  fileAtRef,
  gitRoot,
  isValidRef,
  unstagedFiles,
  untrackedFiles,
} from "../core/git.js";
import { matchesAny } from "../core/glob.js";
import type { Change } from "../core/git.js";
import { buildGraph } from "../core/graph.js";
import { safeFile } from "../core/paths.js";
import { loadRoadmap } from "../core/roadmap.js";
import { installedSkillTargets, readCanonicalSkill } from "../core/skill.js";
import { loadProject } from "../core/store.js";
import { estimateTokens, recordTokens } from "../core/tokens.js";
import { validateConfig, validateDecision } from "../core/validate.js";
import { paint, write, writeError } from "../output.js";
import type { Config, Decision, Issue } from "../types.js";
import { resolveExistingRoot } from "./shared.js";

const DEBT_TRIGGERS: RegExp[] = [
  /(^|\/)package\.json$/,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/,
  /(^|\/)pyproject\.toml$/,
  /(^|\/)requirements\.txt$/,
  /(^|\/)go\.mod$/,
  /(^|\/)Cargo\.toml$/,
  /(^|\/)pom\.xml$/,
  /(^|\/)build\.gradle$/,
  /(^|\/)Gemfile$/,
  /(^|\/)composer\.json$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /^\.github\/workflows\//,
  /^\.steadfast\/config\.yaml$/,
];

const DECISION_FILE = /^\.steadfast\/decisions\/.*\.ya?ml$/;
const DAY_MS = 86_400_000;

function isScratch(path: string): boolean {
  return path.split("/").some((part) => part.startsWith("_"));
}

/**
 * `retire` records itself by adding a glob to `retired_docs`. That config edit
 * must not demand a second decision record; any other config change still
 * counts as decision debt.
 */
function isRetirementOnlyConfigChange(
  root: string,
  ref: string,
  current: Config,
): boolean {
  const text = fileAtRef(root, ref, ".steadfast/config.yaml");
  if (text === undefined) return false;
  try {
    const previous = validateConfig(parse(text), ".steadfast/config.yaml").value;
    const previousRest = { ...previous, retired_docs: [] };
    const currentRest = { ...current, retired_docs: [] };
    if (JSON.stringify(previousRest) !== JSON.stringify(currentRest)) return false;

    // Only additions are self-documenting retirements. Removing a retired glob
    // is an un-retire and must demand a decision record.
    return (
      current.retired_docs.length > previous.retired_docs.length &&
      previous.retired_docs.every((glob) => current.retired_docs.includes(glob))
    );
  } catch {
    return false;
  }
}

function canonical(decision: Decision): string {
  return JSON.stringify({
    id: decision.id,
    topic: decision.topic,
    scope: decision.scope,
    status: decision.status,
    created: decision.created,
    applies_to: [...decision.applies_to].sort(),
    decision: decision.decision,
    why: decision.why ?? [],
    rejected: decision.rejected ?? [],
    guards: decision.guards ?? [],
    enforced_by: decision.enforced_by ?? null,
    supersedes: [...(decision.supersedes ?? [])].sort(),
    by: decision.by,
  });
}

export async function checkCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      diff: { type: "string" },
      strict: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      staged: { type: "boolean", default: false },
      "no-freshness": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  if (values.help) {
    write("steadfast check [--diff <ref>] [--strict] [--json] [--staged] [--no-freshness]");
    write("");
    write("  Validates schema, the supersede graph, freshness, paths and budgets.");
    write("  Exit 1 on error. --strict promotes warnings to failures.");
    write("  --diff   also enforce append-only history and flag undocumented decisions");
    write("  --staged require governed files to match the index (for pre-commit)");
    return 0;
  }

  const root = resolveExistingRoot(values.root);
  if (root === undefined) {
    writeError("error: not a steadfast project (no .steadfast directory); run: steadfast init");
    return 2;
  }

  const loaded = loadProject(root);
  const graph = buildGraph(loaded.decisions, loaded.files);
  const issues: Issue[] = [...loaded.issues, ...graph.issues];
  const index = new FileIndex(root);
  const roadmap = loadRoadmap(root, new Set(loaded.decisions.map((decision) => decision.id)));
  issues.push(...roadmap.issues);
  const roadmapCurrent = roadmap.roadmap?.steps.find((step) => step.status === "current");

  for (const glob of loaded.config.retired_docs) {
    const matches = index.matching([glob]);
    if (matches.length === 0) continue;
    issues.push({
      severity: "error",
      code: "docs/retired-present",
      message: `retired documentation is back: ${matches
        .slice(0, 3)
        .join(", ")}${matches.length > 3 ? ` +${matches.length - 3}` : ""}`,
      fix: "delete it; git history is the archive",
    });
  }

  const isActive = (decision: Decision): boolean => graph.resolved.get(decision.id) === "active";

  if (values.staged) {
    if (gitRoot(root) === undefined) {
      issues.push({
        severity: "error",
        code: "git/unavailable",
        message: "--staged requires a git work tree",
      });
    } else {
      const governed = [
        ...loaded.decisions.filter(isActive).flatMap((decision) => decision.applies_to),
        ...loaded.invariants.flatMap((invariant) => invariant.applies_to ?? []),
      ];
      const watched = new Set(
        governed.length === 0
          ? []
          : listRepoFiles(root).filter((path) => matchesAny(path, governed)),
      );
      for (const decision of loaded.decisions) {
        if (!isActive(decision)) continue;
        if (decision.enforced_by !== undefined && !decision.enforced_by.startsWith("!")) {
          watched.add(decision.enforced_by);
        }
      }
      for (const invariant of loaded.invariants) {
        if (invariant.enforced_by !== undefined && !invariant.enforced_by.startsWith("!")) {
          watched.add(invariant.enforced_by);
        }
      }
      for (const target of installedSkillTargets(root)) {
        watched.add(relative(root, target.path).replace(/\\/g, "/"));
      }

      let changed: string[] = [];
      try {
        changed = [...unstagedFiles(root), ...untrackedFiles(root)];
      } catch (error) {
        issues.push({
          severity: "error",
          code: "git/diff",
          message: `cannot compare the index with the working tree: ${(error as Error).message}`,
        });
      }

      const conflicts = [...new Set(changed)].filter(
        (path) =>
          path.startsWith(".steadfast/") ||
          path.startsWith(".opencode/skills/") ||
          path.startsWith(".claude/skills/") ||
          watched.has(path),
      );
      if (conflicts.length > 0) {
        issues.push({
          severity: "error",
          code: "git/unstaged",
          message: `working tree and index disagree for ${conflicts
            .slice(0, 3)
            .join(", ")}${conflicts.length > 3 ? ` +${conflicts.length - 3}` : ""}`,
          fix: "stage the intended content (git add) and commit again; verify updates the working tree, not the index",
        });
      }
    }
  }

  for (const decision of loaded.decisions) {
    const file = loaded.files.get(decision.id);
    const locate = file === undefined ? {} : { file };

    if (file !== undefined) {
      const name = basename(file);
      if (name !== `${decision.id}.yaml` && name !== `${decision.id}.yml`) {
        issues.push({
          severity: "error",
          code: "path/filename-mismatch",
          message: `record ${decision.id} must live in ${decision.id}.yaml`,
          file,
          id: decision.id,
          fix: `rename the file to ${decision.id}.yaml`,
        });
      }
    }

    if (isActive(decision)) {
      if (index.matching(decision.applies_to).length === 0) {
        issues.push({
          severity: "warning",
          code: "path/no-match",
          message: `applies_to matches no files: ${decision.applies_to.join(", ")}`,
          ...locate,
          id: decision.id,
          fix: "fix the glob, or retire the record",
        });
      }

      if (
        decision.enforced_by !== undefined &&
        !decision.enforced_by.startsWith("!") &&
        safeFile(root, decision.enforced_by) === undefined
      ) {
        issues.push({
          severity: "error",
          code: "path/enforced-by-missing",
          message: `enforced_by file does not exist or escapes the project: ${decision.enforced_by}`,
          ...locate,
          id: decision.id,
          fix: "point at a real test file inside the project, or use !command",
        });
      }

      const tokens = recordTokens(decision);
      if (tokens > loaded.config.budgets.decision_tokens) {
        issues.push({
          severity: "error",
          code: "budget/decision",
          message: `record is ${tokens} tokens; limit is ${loaded.config.budgets.decision_tokens}`,
          ...locate,
          id: decision.id,
          fix: "cut it to one rule; supersede instead of explaining history",
        });
      }
    }

    if (decision.status === "draft") {
      issues.push({
        severity: "warning",
        code: "lint/draft",
        message: "draft records are not in force and are excluded from context",
        ...locate,
        id: decision.id,
        fix: "finish it and set status: active, or delete it",
      });
    }

    if (
      (decision.status === "rejected" || decision.status === "retired") &&
      decision.enforced_by !== undefined
    ) {
      issues.push({
        severity: "warning",
        code: "lint/enforced-on-inactive",
        message: `${decision.status} records cannot be enforced`,
        ...locate,
        id: decision.id,
        fix: "remove enforced_by",
      });
    }
  }

  for (const invariant of loaded.invariants) {
    if (
      invariant.enforced_by !== undefined &&
      !invariant.enforced_by.startsWith("!") &&
      safeFile(root, invariant.enforced_by) === undefined
    ) {
      issues.push({
        severity: "error",
        code: "path/enforced-by-missing",
        message: `invariant enforced_by file does not exist or escapes the project: ${invariant.enforced_by}`,
        file: ".steadfast/invariants.yaml",
        id: invariant.id,
      });
    }
    if (invariant.applies_to !== undefined && index.matching(invariant.applies_to).length === 0) {
      issues.push({
        severity: "warning",
        code: "path/no-match",
        message: `invariant applies_to matches no files: ${invariant.applies_to.join(", ")}`,
        file: ".steadfast/invariants.yaml",
        id: invariant.id,
      });
    }
  }

  let canonicalSkill: string | undefined;
  const skillCopies = installedSkillTargets(root);
  if (skillCopies.length > 0) {
    try {
      canonicalSkill = readCanonicalSkill();
    } catch (error) {
      issues.push({
        severity: "error",
        code: "skill/missing-source",
        message: `cannot read the canonical skill: ${(error as Error).message}`,
      });
    }
  }

  if (canonicalSkill !== undefined) {
    for (const target of skillCopies) {
      const file = relative(root, target.path).replace(/\\/g, "/");
      const safe = safeFile(root, file);
      if (safe === undefined) {
        issues.push({
          severity: "error",
          code: "skill/outside-root",
          message: `${target.platform} skill path escapes the project`,
          file,
        });
        continue;
      }
      if (readFileSync(safe, "utf8") !== canonicalSkill) {
        issues.push({
          severity: "error",
          code: "skill/stale",
          message: `${target.platform} skill copy differs from skills/steadfast/SKILL.md`,
          file,
          fix: `steadfast skill install --platform ${target.platform} --force`,
        });
      }
    }
  }

  const guardSeen = new Map<string, string>();
  for (const decision of loaded.decisions) {
    if (!isActive(decision)) continue;
    for (const guard of decision.guards ?? []) {
      const key = `${guard.deny}\u0000${guard.instead}`;
      const other = guardSeen.get(key);
      if (other !== undefined) {
        const own = other === decision.id;
        issues.push({
          severity: "error",
          code: "lint/duplicate-guard",
          message: own
            ? `duplicate guard inside ${decision.id}: deny "${guard.deny}"`
            : `same guard as ${other}: deny "${guard.deny}"`,
          ...(loaded.files.get(decision.id) === undefined
            ? {}
            : { file: loaded.files.get(decision.id)! }),
          id: decision.id,
          fix: own ? "remove the duplicate guard" : `supersede ${other} instead of repeating it`,
        });
      } else {
        guardSeen.set(key, decision.id);
      }
    }
  }

  if (!values["no-freshness"]) {
    for (const decision of loaded.decisions) {
      if (!isActive(decision) || decision.verified_by === undefined) continue;
      const current = index.fingerprint(decision.applies_to);
      if (current === decision.verified_by) continue;

      const needsAssume =
        decision.enforced_by === undefined || !decision.enforced_by.startsWith("!");
      issues.push({
        severity: "error",
        code: "fresh/stale",
        message: `governed files changed since verification (${decision.verified_by.slice(0, 11)})`,
        ...(loaded.files.get(decision.id) === undefined
          ? {}
          : { file: loaded.files.get(decision.id)! }),
        id: decision.id,
        fix: `steadfast verify ${decision.id}${needsAssume ? " --assume" : " --trust"}`,
      });
    }
  }

  for (const decision of loaded.decisions) {
    if (!isActive(decision) || decision.enforced_by !== undefined) continue;
    const created = Date.parse(`${decision.created}T00:00:00Z`);
    if (!Number.isFinite(created)) continue;
    const age = Math.floor((Date.now() - created) / DAY_MS);
    if (age <= loaded.config.advisory_ttl_days) continue;
    issues.push({
      severity: "warning",
      code: "fresh/advisory-ttl",
      message: `advisory record is ${age} days old; unenforced rules expire`,
      ...(loaded.files.get(decision.id) === undefined
        ? {}
        : { file: loaded.files.get(decision.id)! }),
      id: decision.id,
      fix: "add enforced_by, or supersede it",
    });
  }

  if (values.diff !== undefined) {
    const ref = values.diff;
    if (gitRoot(root) === undefined) {
      issues.push({
        severity: "error",
        code: "git/unavailable",
        message: "--diff requires a git work tree",
      });
    } else if (!isValidRef(root, ref)) {
      issues.push({
        severity: "error",
        code: "git/bad-ref",
        message: `unknown git ref: ${ref}`,
      });
    } else {
      let entries: Change[] = [];
      try {
        entries = changedEntries(root, ref);
      } catch (error) {
        issues.push({
          severity: "error",
          code: "git/diff",
          message: `git diff failed: ${(error as Error).message}`,
        });
      }

      const changed = [
        ...new Set(
          entries.flatMap((entry) => [
            entry.path,
            ...(entry.from === undefined ? [] : [entry.from]),
          ]),
        ),
      ];
      const retirementOnlyConfig =
        changed.includes(".steadfast/config.yaml") &&
        isRetirementOnlyConfigChange(root, ref, loaded.config);
      const triggers = changed.filter(
        (path) =>
          DEBT_TRIGGERS.some((pattern) => pattern.test(path)) &&
          !(path === ".steadfast/config.yaml" && retirementOnlyConfig),
      );
      const decisionsChanged = changed.some(
        (path) => DECISION_FILE.test(path) && !isScratch(path),
      );

      if (triggers.length > 0 && !decisionsChanged) {
        issues.push({
          severity: "warning",
          code: "debt/undocumented-change",
          message: `dependency or build change without a decision record: ${triggers
            .slice(0, 3)
            .join(", ")}${triggers.length > 3 ? ` +${triggers.length - 3}` : ""}`,
          fix: "steadfast new --scope global --topic <topic> --decision \"<rule>\"",
        });
      }

      const readRecord = (file: string): Decision | undefined => {
        const text = fileAtRef(root, ref, file);
        if (text === undefined) return undefined;
        try {
          return validateDecision(parse(text), file).value;
        } catch {
          return undefined;
        }
      };

      for (const entry of entries) {
        const relevant = [entry.path, ...(entry.from === undefined ? [] : [entry.from])].filter(
          (path) => DECISION_FILE.test(path) && !isScratch(path),
        );
        if (relevant.length === 0) continue;

        if (entry.status === "R" || entry.status === "C") {
          const old = entry.from === undefined ? undefined : readRecord(entry.from);
          if (old?.status === "draft") continue;
          issues.push({
            severity: "error",
            code: "history/renamed-record",
            message: "decision records are append-only; renaming hides the old rule",
            file: entry.path,
            fix: "restore the original path and supersede with a new record",
          });
          continue;
        }

        if (entry.status === "D") {
          const old = readRecord(entry.path);
          if (old?.status === "draft") continue;
          issues.push({
            severity: "error",
            code: "history/deleted-record",
            message: "decision records are append-only; this file was deleted",
            file: entry.path,
            fix: "restore it and supersede it with a new record instead",
          });
          continue;
        }

        if (entry.status !== "M") continue;

        const old = readRecord(entry.path);
        if (old?.status === "draft") continue;

        if (!existsSync(join(root, entry.path))) {
          issues.push({
            severity: "error",
            code: "history/deleted-record",
            message: "decision records are append-only; this file was deleted",
            file: entry.path,
            fix: "restore it and supersede it with a new record instead",
          });
          continue;
        }

        const current = loaded.decisions.find(
          (decision) => loaded.files.get(decision.id) === entry.path,
        );
        if (old !== undefined && current !== undefined && canonical(old) !== canonical(current)) {
          issues.push({
            severity: "error",
            code: "history/edited-record",
            message: `record content changed since ${ref} (merge base); only verified_by may change`,
            file: entry.path,
            id: current.id,
            fix: "append a new record and supersede this one",
          });
        }
      }
    }
  }

  const counts: Record<string, number> = {
    active: 0,
    superseded: 0,
    rejected: 0,
    retired: 0,
    draft: 0,
  };
  for (const decision of loaded.decisions) {
    const status = graph.resolved.get(decision.id) ?? decision.status;
    counts[status] = (counts[status] ?? 0) + 1;
  }

  const memoryTokens =
    loaded.decisions.reduce((sum, decision) => sum + recordTokens(decision), 0) +
    loaded.invariants.reduce(
      (sum, invariant) => sum + estimateTokens(JSON.stringify(invariant)),
      0,
    );

  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const failed = errors.length > 0 || (values.strict && warnings.length > 0);

  const sorted = [...errors, ...warnings].sort((a, b) =>
    `${a.id ?? ""}${a.code}`.localeCompare(`${b.id ?? ""}${b.code}`),
  );

  if (values.json) {
    write(
      JSON.stringify(
        {
          ok: !failed,
          root,
          stats: {
            decisions: loaded.decisions.length,
            ...counts,
            invariants: loaded.invariants.length,
            memory_tokens: memoryTokens,
            roadmap_steps: roadmap.roadmap?.steps.length ?? 0,
            roadmap_current: roadmapCurrent?.id ?? null,
            errors: errors.length,
            warnings: warnings.length,
          },
          issues: sorted,
        },
        null,
        2,
      ),
    );
    return failed ? 1 : 0;
  }

  for (const item of sorted) {
    const severity = item.severity === "error" ? paint.red("ERROR") : paint.yellow("WARN ");
    const location = [item.file, item.id === undefined ? "" : `[${item.id}]`]
      .filter(Boolean)
      .join(" ");
    write(`${severity} ${item.code}${location.length > 0 ? ` ${location}` : ""}`);
    write(`  ${item.message}`);
    if (item.fix !== undefined) write(`  fix: ${item.fix}`);
  }

  if (sorted.length > 0) write("");

  const roadmapSummary =
    roadmap.roadmap === undefined
      ? ""
      : ` | roadmap ${roadmap.roadmap.steps.length} steps${roadmapCurrent === undefined ? "" : `, current ${roadmapCurrent.id}`}`;
  write(
    `${paint.bold("steadfast check")} | ${counts.active} active, ${counts.superseded} superseded, ${counts.rejected} rejected, ${counts.retired} retired, ${counts.draft} draft | ${loaded.invariants.length} invariants | ${memoryTokens} memory tokens${roadmapSummary}`,
  );
  const summary = `${errors.length} errors, ${warnings.length} warnings`;
  write(failed ? paint.red(summary) : paint.green(summary));
  if (failed && errors.length === 0 && values.strict && warnings.length > 0) {
    write(paint.dim("strict: warnings are treated as errors"));
  }
  return failed ? 1 : 0;
}
