import { parseArgs } from "node:util";
import { createDecision } from "../core/decision.js";
import { paint, write, writeError } from "../output.js";
import { resolveExistingRoot } from "./shared.js";

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
      json: { type: "boolean", default: false },
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
    write("  --json                  machine-readable result");
    return 0;
  }

  const root = resolveExistingRoot(values.root);
  if (root === undefined) {
    if (values.json) {
      write(
        JSON.stringify(
          { ok: false, messages: ["error: not a steadfast project; run: steadfast init"] },
          null,
          2,
        ),
      );
    } else {
      writeError("error: not a steadfast project (no .steadfast directory); run: steadfast init");
    }
    return 2;
  }

  const result = createDecision(root, {
    scope: values.scope ?? "",
    topic: values.topic ?? "",
    decision: values.decision ?? "",
    why: values.why ?? [],
    status: values.status,
    appliesTo: values["applies-to"] ?? [],
    supersedes: values.supersedes ?? [],
    ...(values["enforced-by"] === undefined ? {} : { enforcedBy: values["enforced-by"] }),
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
  write(`status: ${result.status} | applies_to: ${result.appliesTo!.join(", ")}`);
  if (result.enforcedBy?.startsWith("!")) {
    write(
      `note: freshness recorded, command not executed; run: steadfast verify ${result.id} --trust`,
    );
  }
  if (result.status === "draft") {
    write(
      `next: fill why/guards, then set status: active and run: steadfast verify ${result.id} --assume`,
    );
  }
  return 0;
}
