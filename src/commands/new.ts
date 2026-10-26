import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { FileIndex } from "../core/fingerprint.js";
import { buildGraph } from "../core/graph.js";
import { acquireLock } from "../core/lock.js";
import { insideRoot, safeFile } from "../core/paths.js";
import { loadProject } from "../core/store.js";
import { recordTokens } from "../core/tokens.js";
import { validateDecision } from "../core/validate.js";
import { paint, write, writeError } from "../output.js";
import { today } from "../util.js";
import { resolveExistingRoot } from "./shared.js";

const SLUG = /^[a-z0-9][a-z0-9._-]*$/;
const STATUSES = new Set(["active", "rejected", "retired", "draft"]);

interface CreateOptions {
  root: string;
  decisionsDir: string;
  scope: string;
  topic: string;
  status: string;
  decision: string;
  why: string[];
  appliesTo: string[];
  supersedes: string[];
  enforcedBy?: string;
}

function createRecord(options: CreateOptions): number {
  const { root, decisionsDir, scope, topic, status, decision, enforcedBy } = options;

  const loaded = loadProject(root);
  if (loaded.issues.some((issue) => issue.severity === "error" && issue.code === "project/no-config")) {
    writeError("error: .steadfast/config.yaml is missing; run: steadfast init");
    return 2;
  }
  if (loaded.issues.some((issue) => issue.code === "fs/outside-root")) {
    writeError("error: .steadfast resolves outside the project; refusing to write");
    return 2;
  }

  const graph = buildGraph(loaded.decisions, loaded.files);
  const supersedes = [
    ...new Set(
      options.supersedes
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];

  for (const target of supersedes) {
    const old = loaded.decisions.find((entry) => entry.id === target);
    if (old === undefined) {
      writeError(`error: cannot supersede unknown record "${target}"`);
      return 2;
    }
    if (old.status !== "active" || graph.resolved.get(target) !== "active") {
      writeError(`error: cannot supersede ${target}; it is ${graph.resolved.get(target) ?? old.status}`);
      return 2;
    }
    if (old.scope !== scope || old.topic !== topic) {
      writeError(`error: ${target} owns ${old.scope}/${old.topic}, not ${scope}/${topic}`);
      writeError("  a successor must replace the same rule");
      return 2;
    }
  }

  if (supersedes.length > 0 && status !== "active") {
    writeError("error: only active records can supersede");
    return 2;
  }

  const conflict = loaded.decisions.find(
    (entry) =>
      graph.resolved.get(entry.id) === "active" &&
      entry.scope === scope &&
      entry.topic === topic &&
      !supersedes.includes(entry.id),
  );
  if (conflict !== undefined) {
    writeError(
      `error: active decision ${conflict.id} already owns ${scope}/${topic}; supersede it instead`,
    );
    writeError(
      `  fix: steadfast new --scope ${scope} --topic ${topic} --supersedes ${conflict.id} --status active --decision "<rule>"`,
    );
    return 2;
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

  const appliesTo = options.appliesTo
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (appliesTo.length === 0) {
    appliesTo.push(scope === "global" ? "**" : `${scope}/**`);
  }

  const why = options.why.map((value) => value.trim()).filter(Boolean);
  const base: Record<string, unknown> = {
    topic,
    scope,
    status,
    created: today(),
    applies_to: appliesTo,
    decision,
  };
  if (why.length > 0) base.why = why;
  if (enforcedBy !== undefined) base.enforced_by = enforcedBy;
  if (status === "active") base.verified_by = new FileIndex(root).fingerprint(appliesTo);
  if (supersedes.length > 0) base.supersedes = supersedes;
  base.by = "agent";

  // Exclusive create: parallel agents cannot overwrite each other's id.
  let id = "";
  let path = "";
  let wrote = false;
  for (let offset = 0; offset < 100; offset += 1) {
    id = `ADR-${String(highest + 1 + offset).padStart(4, "0")}`;
    path = join(decisionsDir, `${id}.yaml`);
    const record = { id, ...base };

    const validation = validateDecision(record, `.steadfast/decisions/${id}.yaml`);
    if (validation.issues.some((issue) => issue.severity === "error")) {
      for (const issue of validation.issues) {
        writeError(`error: ${issue.code}: ${issue.message}`);
        if (issue.fix !== undefined) writeError(`  fix: ${issue.fix}`);
      }
      return 2;
    }

    const value = validation.value;
    if (value !== undefined) {
      if (status === "active") {
        const tokens = recordTokens(value);
        if (tokens > loaded.config.budgets.decision_tokens) {
          writeError(
            `error: record is ${tokens} tokens; the limit is ${loaded.config.budgets.decision_tokens}`,
          );
          return 2;
        }
        if (
          value.enforced_by !== undefined &&
          !value.enforced_by.startsWith("!") &&
          safeFile(root, value.enforced_by) === undefined
        ) {
          writeError(
            `error: enforced_by does not resolve to a file inside the project: ${value.enforced_by}`,
          );
          return 2;
        }
      }
      if ((status === "rejected" || status === "retired") && value.enforced_by !== undefined) {
        writeError(`error: ${status} records cannot be enforced`);
        return 2;
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
    writeError("error: could not allocate a decision id after 100 attempts");
    return 2;
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
      writeError(`error: another active record (${rival.id}) claimed ${scope}/${topic} first`);
      return 2;
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
    for (const issue of own) writeError(`error: ${issue.code}: ${issue.message}`);
    return 2;
  }

  write(`${paint.green(id)} .steadfast/decisions/${id}.yaml`);
  write(`status: ${status} | applies_to: ${appliesTo.join(", ")}`);
  if (enforcedBy?.startsWith("!")) {
    write(`note: freshness recorded, command not executed; run: steadfast verify ${id} --trust`);
  }
  if (status === "draft") {
    write(`next: fill why/guards, then set status: active and run: steadfast verify ${id} --assume`);
  }
  return 0;
}

export async function newCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      scope: { type: "string" },
      topic: { type: "string" },
      decision: { type: "string" },
      why: { type: "string", multiple: true },
      status: { type: "string", default: "draft" },
      "applies-to": { type: "string", multiple: true },
      supersedes: { type: "string", multiple: true },
      "enforced-by": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  if (values.help) {
    write("steadfast new --scope <scope> --topic <topic> --decision <text> [options]");
    write("");
    write("  --decision <text>       one sentence; required for every status");
    write("  --why <text>            repeatable; max 3, each one line");
    write("  --status <status>       draft | active | rejected | retired (default: draft)");
    write("  --applies-to <glob>     repeatable; default <scope>/**");
    write("  --enforced-by <value>   test path, or !command");
    write("  --supersedes <id>       repeatable; same scope and topic only");
    return 0;
  }

  const scope = values.scope;
  const topic = values.topic;
  if (scope === undefined || topic === undefined) {
    writeError("error: --scope and --topic are required");
    return 2;
  }
  if (!SLUG.test(scope) || !SLUG.test(topic)) {
    writeError("error: scope and topic must be lowercase slugs (a-z, 0-9, . _ -)");
    return 2;
  }

  const status = values.status;
  if (!STATUSES.has(status)) {
    writeError(`error: invalid status "${status}"`);
    return 2;
  }

  if (values.decision === undefined || values.decision.trim().length === 0) {
    writeError("error: every record needs --decision");
    return 2;
  }

  if (status === "rejected" && (values.why ?? []).length === 0) {
    writeError("error: a rejected record needs --why (the reason it was refused)");
    return 2;
  }

  if (status === "retired" && (values.why ?? []).length === 0) {
    writeError("error: a retired record needs --why (the reason the rule ended)");
    return 2;
  }

  const root = resolveExistingRoot(values.root);
  if (root === undefined) {
    writeError("error: not a steadfast project (no .steadfast directory); run: steadfast init");
    return 2;
  }

  const decisionsDir = join(root, ".steadfast", "decisions");
  mkdirSync(decisionsDir, { recursive: true });
  if (!insideRoot(root, decisionsDir)) {
    writeError("error: .steadfast/decisions resolves outside the project");
    return 2;
  }

  const release = acquireLock(join(decisionsDir, ".lock"));
  try {
    return createRecord({
      root,
      decisionsDir,
      scope,
      topic,
      status,
      decision: values.decision,
      why: values.why ?? [],
      appliesTo: values["applies-to"] ?? [],
      supersedes: values.supersedes ?? [],
      ...(values["enforced-by"] === undefined ? {} : { enforcedBy: values["enforced-by"] }),
    });
  } finally {
    release();
  }
}
