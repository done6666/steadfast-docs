import { parseArgs } from "node:util";
import { createDecision } from "../core/decision.js";
import { buildGraph } from "../core/graph.js";
import { loadProject } from "../core/store.js";
import { paint, write, writeError } from "../output.js";
import { resolveExistingRoot } from "./shared.js";

export async function supersedeCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      decision: { type: "string" },
      why: { type: "string", multiple: true },
      status: { type: "string", default: "active" },
      "applies-to": { type: "string", multiple: true },
      "enforced-by": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    write("steadfast supersede <id> --decision <text> [options]");
    write("");
    write("  Appends a successor with the same scope, topic and applies_to.");
    write("  The old record stays in place and resolves to superseded.");
    write("  enforced_by is inherited unless --enforced-by overrides it; guards and rejected are always inherited.");
    write("");
    write("  --decision <text>       one sentence; required");
    write("  --why <text>            repeatable; max 3");
    write("  --applies-to <glob>     override; defaults to the old record");
    write("  --enforced-by <value>   test path, or !command");
    write("  --json                  machine-readable result");
    return 0;
  }

  const id = positionals[0];
  if (id === undefined) {
    writeError("error: pass the record to supersede, for example: steadfast supersede ADR-0012");
    return 2;
  }
  if (values.decision === undefined || values.decision.trim().length === 0) {
    writeError("error: a successor needs --decision");
    return 2;
  }

  const root = resolveExistingRoot(values.root);
  if (root === undefined) {
    writeError("error: not a steadfast project (no .steadfast directory); run: steadfast init");
    return 2;
  }

  const loaded = loadProject(root);
  const graph = buildGraph(loaded.decisions, loaded.files);
  const old = loaded.decisions.find((entry) => entry.id === id);
  if (old === undefined) {
    writeError(`error: unknown record "${id}"`);
    return 2;
  }
  if (graph.resolved.get(id) !== "active") {
    writeError(`error: ${id} is ${graph.resolved.get(id) ?? old.status}; only active records can be superseded`);
    return 2;
  }

  const appliesTo = (values["applies-to"] ?? []).length > 0 ? values["applies-to"] : old.applies_to;
  const enforcedBy = values["enforced-by"] ?? old.enforced_by;
  const result = createDecision(root, {
    scope: old.scope,
    topic: old.topic,
    decision: values.decision,
    why: values.why ?? [],
    rejected: old.rejected,
    guards: old.guards,
    status: values.status,
    appliesTo,
    supersedes: [id],
    ...(enforcedBy === undefined ? {} : { enforcedBy }),
  });

  if (values.json) {
    write(
      JSON.stringify(
        result.ok
          ? {
              ok: true,
              id: result.id,
              path: result.path,
              status: result.status,
              appliesTo: result.appliesTo,
              supersedes: [id],
              enforcedBy: result.enforcedBy ?? null,
            }
          : { ok: false, messages: result.messages },
        null,
        2,
      ),
    );
    return result.exitCode;
  }

  if (!result.ok) {
    for (const message of result.messages) writeError(message);
    return result.exitCode;
  }

  write(`${paint.green(result.id!)} ${result.path}`);
  write(`supersedes: ${id}`);
  write(`status: ${result.status} | applies_to: ${result.appliesTo!.join(", ")}`);
  if (result.enforcedBy?.startsWith("!")) {
    write(
      `note: freshness recorded, command not executed; run: steadfast verify ${result.id} --trust`,
    );
  }
  return 0;
}
