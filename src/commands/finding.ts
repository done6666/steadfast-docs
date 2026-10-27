import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import {
  buildFindingGraph,
  findingTokens,
  validateFinding,
} from "../core/finding.js";
import { acquireLock } from "../core/lock.js";
import { insideRoot, safeFile } from "../core/paths.js";
import { loadProject } from "../core/store.js";
import { paint, write, writeError } from "../output.js";
import type { Confidence, Finding, FindingStatus } from "../types.js";
import { today } from "../util.js";
import { resolveExistingRoot } from "./shared.js";

const ID_RE = /^FIND-[0-9]{4,}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;
const STATUSES = new Set<FindingStatus>(["active", "retracted", "retired"]);
const CONFIDENCES = new Set<Confidence>(["high", "medium", "low"]);

interface Options {
  root?: string;
  scope?: string;
  topic?: string;
  target?: string;
  claim?: string;
  evidence?: string;
  confidence?: string;
  "observed-at"?: string;
  "applies-to"?: string[];
  why?: string[];
  json: boolean;
  help: boolean;
}

function usage(): void {
  write("steadfast finding <new|supersede|retract|retire|explain> [options]");
  write("");
  write("  new       record an observation");
  write("  supersede correct or re-observe an active finding");
  write("  retract   mark an active finding false");
  write("  retire    replace an active finding with a test that proves it");
  write("  explain   print one finding");
  write("");
  write("  --scope <slug>        subsystem; use global for repo-wide");
  write("  --topic <slug>        stable topic key");
  write("  --target <name@ver>   artifact and version observed");
  write("  --claim <sentence>    one fact");
  write("  --evidence <path>     repo-relative script/log, or !command");
  write("  --confidence <level>  high | medium | low");
  write("  --applies-to <glob>   repeatable; where the finding is relevant");
  write("  --observed-at <date>  default today");
  write("  --why <text>          retraction reason; repeatable");
}

function listFindingFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .filter((name): name is string => typeof name === "string")
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => String(name));
}

function checkEvidence(root: string, evidence: string): boolean {
  return evidence.startsWith("!") || safeFile(root, evidence) !== undefined;
}

function validateRecord(
  root: string,
  record: Finding,
  file: string,
  config: ReturnType<typeof loadProject>["config"],
): string[] {
  const issues = validateFinding(record, file).issues.filter(
    (issue) => issue.severity === "error",
  );
  const messages = issues.flatMap((issue) => [
    `error: ${issue.code}: ${issue.message}`,
    ...(issue.fix === undefined ? [] : [`  fix: ${issue.fix}`]),
  ]);
  if (!checkEvidence(root, record.evidence)) {
    messages.push(`error: evidence does not resolve to a file inside the project: ${record.evidence}`);
  }
  const tokens = findingTokens(record);
  if (tokens > config.budgets.finding_tokens) {
    messages.push(
      `error: finding is ${tokens} tokens; the limit is ${config.budgets.finding_tokens}`,
    );
  }
  return messages;
}

export async function findingCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      scope: { type: "string" },
      topic: { type: "string" },
      target: { type: "string" },
      claim: { type: "string" },
      evidence: { type: "string" },
      confidence: { type: "string" },
      "observed-at": { type: "string" },
      "applies-to": { type: "string", multiple: true },
      why: { type: "string", multiple: true },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    } as const,
    allowPositionals: true,
    strict: true,
  });

  const opts = values as Options;
  if (opts.help) {
    usage();
    return 0;
  }

  const action = positionals[0];
  const id = positionals[1];
  if (
    action === undefined ||
    !["new", "supersede", "retract", "retire", "explain"].includes(action)
  ) {
    usage();
    return 2;
  }

  const root = resolveExistingRoot(opts.root);
  if (root === undefined) {
    writeError("error: not a steadfast project (no .steadfast directory); run: steadfast init");
    return 2;
  }

  if (action === "explain") {
    if (id === undefined || !ID_RE.test(id)) {
      writeError("error: explain needs a FIND id");
      return 2;
    }
    const loaded = loadProject(root);
    const graph = buildFindingGraph(loaded.findings, loaded.findingFiles);
    const finding = loaded.findings.find((entry) => entry.id === id);
    if (finding === undefined) {
      writeError(`error: unknown finding "${id}"`);
      return 2;
    }
    const info = {
      ...finding,
      resolved: graph.resolved.get(id) ?? finding.status,
      superseded_by: graph.supersededBy.get(id) ?? null,
    };
    if (opts.json) {
      write(JSON.stringify(info, null, 2));
    } else {
      write(`${paint.green(id)} ${info.resolved}`);
      write(`target: ${finding.target}`);
      write(`claim: ${finding.claim}`);
      write(`confidence: ${finding.confidence} | observed: ${finding.observed_at}`);
      write(`evidence: ${finding.evidence}`);
      write(`applies_to: ${finding.applies_to.join(", ")}`);
      if (info.superseded_by !== null) write(`superseded_by: ${info.superseded_by}`);
    }
    return 0;
  }

  const loaded = loadProject(root);
  if (
    loaded.issues.some(
      (issue) => issue.severity === "error" && issue.code === "project/no-config",
    )
  ) {
    writeError("error: .steadfast/config.yaml is missing; run: steadfast init");
    return 2;
  }
  if (loaded.issues.some((issue) => issue.code === "fs/outside-root")) {
    writeError("error: .steadfast resolves outside the project; refusing to write");
    return 2;
  }
  const graph = buildFindingGraph(loaded.findings, loaded.findingFiles);
  const predecessor =
    action === "new"
      ? undefined
      : loaded.findings.find((finding) => finding.id === id);
  if (action !== "new") {
    if (id === undefined || !ID_RE.test(id)) {
      writeError("error: this action needs a FIND id");
      return 2;
    }
    if (predecessor === undefined) {
      writeError(`error: unknown finding "${id}"`);
      return 2;
    }
    if (graph.resolved.get(predecessor.id) !== "active") {
      writeError(
        `error: cannot ${action} ${predecessor.id}; it is ${graph.resolved.get(predecessor.id)}`,
      );
      return 2;
    }
  }

  if (
    action === "supersede" &&
    opts.claim === undefined &&
    opts.evidence === undefined &&
    opts.target === undefined &&
    opts.confidence === undefined
  ) {
    writeError(
      "error: supersede needs new content: pass --claim, --evidence, --target or --confidence",
    );
    return 2;
  }

  const scope = opts.scope ?? predecessor?.scope ?? "";
  const topic = opts.topic ?? predecessor?.topic ?? "";
  const target = opts.target ?? predecessor?.target ?? "";
  const claim = opts.claim ?? predecessor?.claim ?? "";
  const evidence = opts.evidence ?? predecessor?.evidence ?? "";
  const confidence = opts.confidence ?? predecessor?.confidence ?? "medium";
  const observedAt = opts["observed-at"] ?? today();
  const appliesTo =
    opts["applies-to"] !== undefined
      ? opts["applies-to"].flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean)
      : (predecessor?.applies_to ?? []);

  if (!SLUG_RE.test(scope)) {
    writeError("error: --scope must be a lowercase slug");
    return 2;
  }
  if (!SLUG_RE.test(topic)) {
    writeError("error: --topic must be a lowercase slug");
    return 2;
  }
  if (target.trim().length === 0) {
    writeError("error: --target is required");
    return 2;
  }
  if (claim.trim().length === 0) {
    writeError("error: --claim is required");
    return 2;
  }
  if (evidence.trim().length === 0) {
    writeError("error: --evidence is required");
    return 2;
  }
  if (!CONFIDENCES.has(confidence as Confidence)) {
    writeError("error: --confidence must be high, medium or low");
    return 2;
  }
  if (appliesTo.length === 0) {
    writeError("error: --applies-to is required");
    return 2;
  }

  let status: FindingStatus = "active";
  const why = (opts.why ?? []).map((value) => value.trim()).filter(Boolean);
  if (action === "retract") {
    status = "retracted";
    if (why.length === 0) {
      writeError("error: retract needs --why (the reason the claim is false)");
      return 2;
    }
  }
  if (action === "retire") {
    status = "retired";
    if (opts.evidence === undefined) {
      writeError("error: retire needs --evidence: the test that now proves the claim");
      return 2;
    }
  }
  if (!STATUSES.has(status)) {
    writeError(`error: invalid status "${status}"`);
    return 2;
  }

  const dir = join(root, ".steadfast", "findings");
  mkdirSync(dir, { recursive: true });
  if (!insideRoot(root, dir)) {
    writeError("error: .steadfast/findings resolves outside the project");
    return 2;
  }

  let release: (() => void) | undefined;
  try {
    release = acquireLock(join(dir, ".lock"));
  } catch (error) {
    writeError(`error: ${(error as Error).message}`);
    return 2;
  }

  try {
    const highest = Math.max(
      0,
      ...listFindingFiles(dir)
        .map((name) => /FIND-(\d+)\.ya?ml$/.exec(name)?.[1])
        .filter((value): value is string => value !== undefined)
        .map(Number),
      ...loaded.findings.map((finding) => Number(finding.id.slice(5))),
    );

    const conflict = loaded.findings.find(
      (finding) =>
        graph.resolved.get(finding.id) === "active" &&
        finding.id !== id &&
        finding.scope === scope &&
        finding.topic === topic &&
        finding.target === target,
    );
    if (conflict !== undefined) {
      writeError(
        `error: active finding ${conflict.id} already covers ${scope}/${topic}@${target}; supersede it instead`,
      );
      return 2;
    }

    for (let offset = 0; offset < 100; offset += 1) {
      const nextId = `FIND-${String(highest + 1 + offset).padStart(4, "0")}`;
      const file = `.steadfast/findings/${nextId}.yaml`;
      const record: Finding = {
        id: nextId,
        topic,
        scope,
        status,
        target,
        claim,
        evidence,
        confidence: confidence as Confidence,
        observed_at: observedAt,
        applies_to: appliesTo,
        by: "agent",
      };
      if (why.length > 0) record.why = why;
      if (predecessor !== undefined) record.supersedes = [predecessor.id];

      const messages = validateRecord(root, record, file, loaded.config);
      if (messages.length > 0) {
        for (const message of messages) writeError(message);
        return 2;
      }

      try {
        writeFileSync(join(root, file), stringify(record, { lineWidth: 0 }), { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }

      const after = loadProject(root);
      const afterGraph = buildFindingGraph(after.findings, after.findingFiles);
      const own = [...after.issues, ...afterGraph.issues].filter(
        (issue) => issue.id === nextId && issue.severity === "error",
      );
      if (own.length > 0) {
        unlinkSync(join(root, file));
        for (const issue of own) writeError(`error: ${issue.code}: ${issue.message}`);
        return 2;
      }

      if (opts.json) {
        write(
          JSON.stringify(
            { ok: true, id: nextId, path: file, action, status },
            null,
            2,
          ),
        );
      } else {
        write(`${paint.green(nextId)} ${file}`);
        write(`status: ${status} | target: ${target} | confidence: ${confidence}`);
      }
      return 0;
    }

    writeError("error: could not allocate a finding id after 100 attempts");
    return 2;
  } finally {
    release?.();
  }
}
