import { parseArgs } from "node:util";
import { buildGraph } from "../core/graph.js";
import { loadProject } from "../core/store.js";
import { paint, write, writeError } from "../output.js";
import { resolveExistingRoot } from "./shared.js";

export async function explainCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    write("steadfast explain <id> [--json]");
    write("");
    write("  Prints one record's metadata without loading the archive.");
    return 0;
  }

  const id = positionals[0];
  if (id === undefined) {
    writeError("error: pass a decision id, for example: steadfast explain ADR-0012");
    return 2;
  }

  const root = resolveExistingRoot(values.root);
  if (root === undefined) {
    writeError("error: not a steadfast project (no .steadfast directory); run: steadfast init");
    return 2;
  }

  const loaded = loadProject(root);
  const graph = buildGraph(loaded.decisions, loaded.files);
  const decision = loaded.decisions.find((entry) => entry.id === id);
  if (decision === undefined) {
    writeError(`error: unknown record "${id}"`);
    return 2;
  }

  const info = {
    ...decision,
    resolved: graph.resolved.get(id) ?? decision.status,
    superseded_by: graph.supersededBy.get(id) ?? null,
  };

  if (values.json) {
    write(JSON.stringify(info, null, 2));
    return 0;
  }

  write(`${paint.green(id)} ${info.resolved}`);
  write(`scope: ${decision.scope} | topic: ${decision.topic}`);
  write(`applies_to: ${decision.applies_to.join(", ")}`);
  write(`decision: ${decision.decision}`);
  if (decision.why && decision.why.length > 0) {
    write("why:");
    for (const item of decision.why) write(`  - ${item}`);
  }
  if (decision.rejected && decision.rejected.length > 0) {
    write("rejected:");
    for (const item of decision.rejected) write(`  - ${item}`);
  }
  if (decision.guards && decision.guards.length > 0) {
    write("guards:");
    for (const guard of decision.guards) {
      write(`  - deny: ${guard.deny}`);
      write(`    instead: ${guard.instead}`);
      if (guard.check !== undefined) write(`    check: ${guard.check}`);
    }
  }
  if (decision.enforced_by !== undefined) write(`enforced_by: ${decision.enforced_by}`);
  if (decision.verified_by !== undefined) write(`verified_by: ${decision.verified_by}`);
  if (decision.supersedes && decision.supersedes.length > 0) {
    write(`supersedes: ${decision.supersedes.join(", ")}`);
  }
  if (info.superseded_by !== null) write(`superseded_by: ${info.superseded_by}`);
  write(`created: ${decision.created} | by: ${decision.by}`);
  return 0;
}
