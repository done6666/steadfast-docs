import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CLI, cli, tempDir, write } from "./helpers.js";

test("mcp exposes the memory tools over stdio", () => {
  const root = tempDir();
  write(root, "src/a.ts", "export const a = 1;\n");
  write(root, "test/a.test.ts", "export {};\n");
  assert.equal(cli(["init"], root).status, 0);
  assert.equal(
    cli(
      [
        "new",
        "--scope",
        "global",
        "--topic",
        "rule",
        "--decision",
        "Rule one.",
        "--applies-to",
        "src/**",
        "--status",
        "active",
        "--enforced-by",
        "test/a.test.ts",
      ],
      root,
    ).status,
    0,
  );

  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "context", arguments: { paths: ["src/a.ts"] } },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "explain", arguments: { id: "ADR-0001" } },
    },
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "check", arguments: { strict: true } },
    },
    {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "doctor", arguments: {} },
    },
  ];

  const input = [
    ...requests.map((request) => JSON.stringify(request)),
    "null",
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/unknown" }),
  ].join("\n");

  const result = spawnSync(process.execPath, [CLI, "mcp"], {
    cwd: root,
    input: `${input}\n`,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);

  const messages = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as {
      id?: number | null;
      result?: any;
      error?: { code: number; message: string };
    });
  const byId = new Map(messages.map((message) => [message.id, message.result]));

  assert.equal(messages.length, 7);
  assert.equal(byId.get(null as any), undefined);
  const invalid = messages.find((message) => message.id === null);
  assert.equal(invalid?.error?.code, -32600);

  assert.equal(byId.get(1).protocolVersion, "2025-06-18");
  assert.equal(byId.get(1).serverInfo.name, "steadfast");
  const tools = byId.get(2).tools as Array<{
    name: string;
    inputSchema: { properties: Record<string, unknown> };
  }>;
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["check", "context", "doctor", "explain", "new", "supersede", "verify"],
  );
  const verify = tools.find((tool) => tool.name === "verify");
  assert.equal("trust" in (verify?.inputSchema.properties ?? {}), false);
  assert.equal("run" in (verify?.inputSchema.properties ?? {}), false);

  assert.match(byId.get(3).content[0].text, /^# steadfast context v1/);
  assert.equal(JSON.parse(byId.get(4).content[0].text).id, "ADR-0001");
  assert.equal(JSON.parse(byId.get(5).content[0].text).ok, true);
  assert.equal(JSON.parse(byId.get(6).content[0].text).ok, true);
});

test("mcp never executes record commands from verify", () => {
  const root = tempDir();
  const marker = join(root, "executed");
  const injected = join(root, "injected");
  write(root, "src/a.ts", "export const a = 1;\n");
  assert.equal(cli(["init"], root).status, 0);
  assert.equal(
    cli(
      [
        "new",
        "--scope",
        "global",
        "--topic",
        "exec",
        "--decision",
        "Never run this from MCP.",
        "--applies-to",
        "src/**",
        "--status",
        "active",
        "--enforced-by",
        `!touch ${marker}`,
      ],
      root,
    ).status,
    0,
  );

  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "verify", arguments: { ids: ["ADR-0001"], trust: true } },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "verify",
        arguments: { ids: ["--run", `touch ${injected}`, "ADR-0001"] },
      },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "verify", arguments: { ids: ["--trust", "ADR-0001"] } },
    },
  ];

  const result = spawnSync(process.execPath, [CLI, "mcp"], {
    cwd: root,
    input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { id?: number; result?: any });
  const verify = messages.find((message) => message.id === 2)?.result;
  assert.equal(verify.isError, true);
  assert.match(verify.content[0].text, /executable code/);
  for (const id of [3, 4]) {
    const rejected = messages.find((message) => message.id === id)?.result;
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /invalid decision id/);
  }
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(injected), false);
});
