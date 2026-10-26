import { parseArgs } from "node:util";
import { buildGraph } from "../core/graph.js";
import { buildPack } from "../core/pack.js";
import { loadProject } from "../core/store.js";
import { write, writeError } from "../output.js";
import { resolveExistingRoot } from "./shared.js";

export async function contextCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      for: { type: "string", multiple: true },
      scope: { type: "string" },
      budget: { type: "string" },
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
    write("  --for     repo-relative paths; repeatable or comma-separated; filters by applies_to");
    write("  --scope   include every record in this scope (global records apply)");
    write("  --budget  override config budget");
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

  const budget =
    values.budget === undefined ? loaded.config.budgets.context_tokens : Number(values.budget);
  if (!Number.isFinite(budget) || budget <= 0) {
    writeError(`error: invalid --budget "${values.budget}"`);
    return 2;
  }

  const pack = buildPack(loaded.decisions, loaded.invariants, graph.resolved, {
    paths,
    scope: values.scope,
    budget,
    maxGuards: loaded.config.budgets.guards,
  });

  if (pack.issues.some((issue) => issue.severity === "error")) {
    for (const issue of pack.issues) writeError(`error: ${issue.message}`);
    for (const issue of pack.issues) if (issue.fix) writeError(`  fix: ${issue.fix}`);
    return 2;
  }

  if (values.json) {
    write(
      JSON.stringify(
        {
          tokens: pack.tokens,
          budget: pack.budget,
          omitted: pack.omitted,
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
