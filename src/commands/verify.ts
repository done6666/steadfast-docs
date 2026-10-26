import { execSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { FileIndex } from "../core/fingerprint.js";
import { buildGraph } from "../core/graph.js";
import { safeFile } from "../core/paths.js";
import { loadProject } from "../core/store.js";
import { paint, write, writeError } from "../output.js";
import { resolveExistingRoot } from "./shared.js";

const RECORD_TIMEOUT_MS = 120_000;
const RUN_TIMEOUT_MS = 600_000;

export async function verifyCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      run: { type: "string" },
      assume: { type: "boolean", default: false },
      trust: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    write("steadfast verify <id...> | --all [--run <command>] [--assume] [--trust]");
    write("");
    write("  Recomputes the content fingerprint of each record's applies_to files.");
    write("  Records with enforced_by \"!cmd\" are executable code and require --trust.");
    write("  --all                 verify every active record");
    write("  --run \"<command>\"      run one command for explicit ids (not --all)");
    write("  --assume              assert that path-only/advisory checks already passed");
    return 0;
  }

  const requested = positionals;
  if (values.all && requested.length > 0) {
    writeError("error: use either explicit ids or --all, not both");
    return 2;
  }
  if (!values.all && requested.length === 0) {
    writeError("error: pass at least one decision id, or --all");
    return 2;
  }
  if (values.all && values.run !== undefined) {
    writeError("error: --run needs explicit ids; --all would stamp records the command does not cover");
    return 2;
  }

  const root = resolveExistingRoot(values.root);
  if (root === undefined) {
    writeError("error: not a steadfast project (no .steadfast directory); run: steadfast init");
    return 2;
  }

  const loaded = loadProject(root);
  const graph = buildGraph(loaded.decisions, loaded.files);
  const byId = new Map(loaded.decisions.map((decision) => [decision.id, decision]));

  const ids = values.all
    ? loaded.decisions
        .filter((decision) => graph.resolved.get(decision.id) === "active")
        .map((decision) => decision.id)
    : requested;

  if (ids.length === 0) {
    writeError("error: no active records to verify");
    return 2;
  }

  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    writeError(`error: unknown record(s): ${missing.join(", ")}`);
    return 2;
  }

  const failed = new Set<string>();
  const active: string[] = [];

  for (const id of ids) {
    const decision = byId.get(id)!;
    if (graph.resolved.get(id) !== "active") {
      writeError(`error: ${id} is ${graph.resolved.get(id) ?? decision.status}; only active records are verified`);
      failed.add(id);
      continue;
    }
    active.push(id);
  }

  if (active.length === 0) return 1;

  if (values.run !== undefined) {
    if (values.run.trim().length === 0) {
      writeError("error: --run needs a command");
      return 2;
    }
    try {
      execSync(values.run, { cwd: root, stdio: "inherit", timeout: RUN_TIMEOUT_MS });
    } catch {
      writeError(`error: command failed: ${values.run}`);
      return 1;
    }
  } else {
    for (const id of active) {
      const decision = byId.get(id)!;
      const enforced = decision.enforced_by;

      if (enforced !== undefined && enforced.startsWith("!")) {
        if (!values.trust) {
          writeError(`error: ${id} enforced_by is executable code: ${enforced}`);
          writeError("  review it, then retry with --trust");
          failed.add(id);
          continue;
        }
        const command = enforced.slice(1).trim();
        try {
          execSync(command, { cwd: root, stdio: "inherit", timeout: RECORD_TIMEOUT_MS });
        } catch {
          writeError(`error: enforced_by failed for ${id}: ${command}`);
          failed.add(id);
        }
        continue;
      }

      if (!values.assume) {
        const reason =
          enforced === undefined
            ? "an advisory record"
            : `enforced by ${enforced}, which is a file and cannot be executed by this tool`;
        writeError(`error: ${id} is ${reason}`);
        writeError("  run the check yourself and retry with --assume, or pass --run \"<command>\"");
        failed.add(id);
      }
    }
  }

  const index = new FileIndex(root);

  for (const id of active) {
    if (failed.has(id)) continue;
    const decision = byId.get(id)!;
    const file = loaded.files.get(id);
    const path = file === undefined ? undefined : safeFile(root, file);
    if (path === undefined) {
      writeError(`error: ${id} does not resolve to a record file inside the project`);
      failed.add(id);
      continue;
    }

    const fingerprint = index.fingerprint(decision.applies_to);
    const text = readFileSync(path, "utf8");
    const line = `verified_by: ${fingerprint}`;
    const next = /^verified_by\s*:.*$/m.test(text)
      ? text.replace(/^verified_by\s*:.*$/m, line)
      : `${text.replace(/\s*$/, "")}\n${line}\n`;

    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, next);
    renameSync(temporary, path);

    write(`${paint.green("verified")} ${id} ${fingerprint.slice(0, 11)}`);
  }

  return failed.size > 0 ? 1 : 0;
}
