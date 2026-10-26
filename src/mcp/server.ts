import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { findProjectRoot } from "../core/store.js";
import { toPosix } from "../util.js";
import { VERSION } from "../version.js";

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));
const START = resolve(process.env.STEADFAST_ROOT ?? process.cwd());
const ROOT = findProjectRoot(START) ?? START;
const SUPPORTED_PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const ID = /^ADR-[0-9]{4,}$/;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface ToolResult {
  text: string;
  isError: boolean;
}

function runCli(args: string[], timeout = 120_000): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1", PWD: ROOT },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function failure(result: CliResult): ToolResult {
  return {
    text: `${result.stderr}${result.stdout}`.trim() || `steadfast exited with ${result.status}`,
    isError: true,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function repoPath(value: string): string | undefined {
  const absolute = isAbsolute(value) ? value : resolve(ROOT, value);
  const path = toPosix(relative(ROOT, absolute));
  if (path.length === 0 || path === ".." || path.startsWith("../") || isAbsolute(path)) {
    return undefined;
  }
  return path;
}

function contextTool(args: Record<string, unknown>): ToolResult {
  const paths = stringArray(args.paths);
  const scope = typeof args.scope === "string" ? args.scope : undefined;
  const budget = typeof args.budget === "number" ? args.budget : undefined;
  if (paths.length === 0 && scope === undefined) {
    return { text: "error: pass paths or scope", isError: true };
  }

  const normalized: string[] = [];
  for (const path of paths) {
    const value = repoPath(path);
    if (value === undefined) {
      return { text: `error: path escapes the project: ${path}`, isError: true };
    }
    normalized.push(value);
  }

  const cliArgs = ["context", "--json"];
  for (const path of normalized) cliArgs.push("--for", path);
  if (scope !== undefined) cliArgs.push("--scope", scope);
  if (budget !== undefined) cliArgs.push("--budget", String(budget));

  const result = runCli(cliArgs);
  if (result.status !== 0) return failure(result);

  try {
    const parsed = JSON.parse(result.stdout) as {
      text?: string;
      tokens?: number;
      budget?: number;
      omitted?: number;
      included?: unknown;
    };
    return { text: parsed.text ?? result.stdout, isError: false };
  } catch {
    return { text: result.stdout, isError: false };
  }
}

function checkTool(args: Record<string, unknown>): ToolResult {
  const cliArgs = ["check", "--json"];
  if (typeof args.diff === "string") cliArgs.push("--diff", args.diff);
  if (args.strict === true) cliArgs.push("--strict");
  if (args.noFreshness === true) cliArgs.push("--no-freshness");
  const result = runCli(cliArgs);
  if (result.stdout.trim().length > 0) {
    return { text: result.stdout.trim(), isError: result.status !== 0 };
  }
  return failure(result);
}

function verifyTool(args: Record<string, unknown>): ToolResult {
  const ids = stringArray(args.ids);
  const invalid = ids.find((id) => !ID.test(id));
  if (invalid !== undefined) {
    return { text: `error: invalid decision id: ${invalid}`, isError: true };
  }

  const cliArgs = ["verify"];
  if (args.all === true) cliArgs.push("--all");
  if (args.assume === true) cliArgs.push("--assume");
  if (ids.length > 0) cliArgs.push("--", ...ids);
  const result = runCli(cliArgs, 620_000);
  const text = `${result.stdout}${result.stderr}`.trim();
  return { text: text || `steadfast verify exited with ${result.status}`, isError: result.status !== 0 };
}

function newTool(args: Record<string, unknown>): ToolResult {
  const required = ["scope", "topic", "decision"] as const;
  for (const key of required) {
    if (typeof args[key] !== "string" || (args[key] as string).length === 0) {
      return { text: `error: ${key} is required`, isError: true };
    }
  }

  const cliArgs = [
    "new",
    "--json",
    "--scope",
    args.scope as string,
    "--topic",
    args.topic as string,
    "--decision",
    args.decision as string,
    "--status",
    typeof args.status === "string" ? args.status : "draft",
  ];
  for (const why of stringArray(args.why)) cliArgs.push("--why", why);
  for (const glob of stringArray(args.appliesTo)) cliArgs.push("--applies-to", glob);
  for (const id of stringArray(args.supersedes)) cliArgs.push("--supersedes", id);
  if (typeof args.enforcedBy === "string") cliArgs.push("--enforced-by", args.enforcedBy);

  const result = runCli(cliArgs);
  return {
    text: result.stdout.trim() || result.stderr.trim(),
    isError: result.status !== 0,
  };
}

function explainTool(args: Record<string, unknown>): ToolResult {
  if (typeof args.id !== "string" || !ID.test(args.id)) {
    return { text: "error: a valid ADR id is required", isError: true };
  }
  const result = runCli(["explain", "--json", "--", args.id]);
  return {
    text: result.stdout.trim() || result.stderr.trim(),
    isError: result.status !== 0,
  };
}

function supersedeTool(args: Record<string, unknown>): ToolResult {
  if (typeof args.id !== "string" || !ID.test(args.id) || typeof args.decision !== "string") {
    return { text: "error: a valid id and decision are required", isError: true };
  }

  const cliArgs = ["supersede", "--json", "--decision", args.decision];
  if (typeof args.status === "string") cliArgs.push("--status", args.status);
  for (const why of stringArray(args.why)) cliArgs.push("--why", why);
  for (const glob of stringArray(args.appliesTo)) cliArgs.push("--applies-to", glob);
  if (typeof args.enforcedBy === "string") cliArgs.push("--enforced-by", args.enforcedBy);
  cliArgs.push("--", args.id);

  const result = runCli(cliArgs);
  return {
    text: result.stdout.trim() || result.stderr.trim(),
    isError: result.status !== 0,
  };
}

function doctorTool(): ToolResult {
  const result = runCli(["doctor", "--json"]);
  return {
    text: result.stdout.trim() || result.stderr.trim(),
    isError: result.status !== 0,
  };
}

const TOOLS = [
  {
    name: "context",
    description:
      "Compile the token-budgeted memory pack for the paths you will touch. Read only this output; do not open .steadfast/decisions or legacy docs.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, minItems: 1 },
        scope: { type: "string" },
        budget: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "check",
    description:
      "Validate the memory graph, freshness, paths, budgets and append-only history. Run before committing.",
    inputSchema: {
      type: "object",
      properties: {
        diff: { type: "string" },
        strict: { type: "boolean" },
        noFreshness: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "verify",
    description:
      "Recompute content fingerprints after the tests pass. Use assume for file-backed checks. This tool never executes record-supplied commands; a human runs `steadfast verify --trust` in a terminal.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" } },
        all: { type: "boolean" },
        assume: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "new",
    description:
      "Append a decision record. Never edit an active record; use supersede to change a rule.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        topic: { type: "string" },
        decision: { type: "string" },
        why: { type: "array", items: { type: "string" } },
        appliesTo: { type: "array", items: { type: "string" } },
        status: { enum: ["active", "rejected", "retired", "draft"] },
        supersedes: { type: "array", items: { type: "string" } },
        enforcedBy: { type: "string" },
      },
      required: ["scope", "topic", "decision"],
      additionalProperties: false,
    },
  },
  {
    name: "explain",
    description: "Print one record's metadata without loading the archive.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "supersede",
    description:
      "Append a successor with the same scope, topic and applies_to. The old record resolves to superseded.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        decision: { type: "string" },
        why: { type: "array", items: { type: "string" } },
        appliesTo: { type: "array", items: { type: "string" } },
        status: { enum: ["active", "rejected", "retired", "draft"] },
        enforcedBy: { type: "string" },
      },
      required: ["id", "decision"],
      additionalProperties: false,
    },
  },
  {
    name: "doctor",
    description: "Diagnose AGENTS.md, skill, MCP, hook, freshness and retired docs.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function callTool(name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case "context":
      return contextTool(args);
    case "check":
      return checkTool(args);
    case "verify":
      return verifyTool(args);
    case "new":
      return newTool(args);
    case "explain":
      return explainTool(args);
    case "supersede":
      return supersedeTool(args);
    case "doctor":
      return doctorTool();
    default:
      return { text: `error: unknown tool "${name}"`, isError: true };
  }
}

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id: string | number | null | undefined, result: unknown): void {
  write({ jsonrpc: "2.0", id: id ?? null, result });
}

function respondError(
  id: string | number | null | undefined,
  code: number,
  message: string,
): void {
  write({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function handle(request: JsonRpcRequest): void {
  if (request.id === undefined) {
    if (request.method === "exit") process.exit(0);
    return;
  }

  if (request.method === "initialize") {
    const requested = request.params?.protocolVersion;
    const protocolVersion =
      typeof requested === "string" && SUPPORTED_PROTOCOLS.includes(requested)
        ? requested
        : "2025-06-18";
    respond(request.id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "steadfast", version: VERSION },
      instructions:
        "Steadfast memory is available. Before editing, call context with the paths you will touch and read only that output. Call check and verify before finishing. Never edit an active record; append a successor with supersede.",
    });
    return;
  }

  if (request.method === "notifications/initialized") return;
  if (request.method === "notifications/cancelled") return;
  if (request.method === "ping") {
    respond(request.id, {});
    return;
  }
  if (request.method === "tools/list") {
    respond(request.id, { tools: TOOLS });
    return;
  }
  if (request.method === "tools/call") {
    const name = request.params?.name;
    const args = request.params?.arguments;
    if (typeof name !== "string") {
      respondError(request.id, -32602, "tool name is required");
      return;
    }
    const result = callTool(
      name,
      typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {},
    );
    respond(request.id, {
      content: [{ type: "text", text: result.text }],
      ...(result.isError ? { isError: true } : {}),
    });
    return;
  }
  if (request.method === "shutdown") {
    respond(request.id, null);
    return;
  }
  if (request.method === "exit") {
    process.exit(0);
  }

  respondError(request.id, -32601, `unknown method "${request.method}"`);
}

export function startMcpServer(): void {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      respondError(null, -32700, "invalid JSON");
      return;
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof (parsed as { method?: unknown }).method !== "string"
    ) {
      respondError(null, -32600, "invalid request");
      return;
    }

    const request = parsed as JsonRpcRequest;
    if (
      request.id !== undefined &&
      request.id !== null &&
      typeof request.id !== "string" &&
      typeof request.id !== "number"
    ) {
      respondError(null, -32600, "invalid request id");
      return;
    }

    try {
      handle(request);
    } catch (error) {
      if (request.id !== undefined) {
        respondError(
          request.id,
          -32603,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  });
}
