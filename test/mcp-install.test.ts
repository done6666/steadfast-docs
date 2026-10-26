import assert from "node:assert/strict";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { cli, tempDir, write } from "./helpers.js";

const noAgentPath = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
};

test("mcp install writes a Claude .mcp.json fallback", () => {
  const root = tempDir();
  assert.equal(cli(["init"], root).status, 0);

  const installed = cli(["mcp", "install", "--platform", "claude"], root, noAgentPath);
  assert.equal(installed.status, 0, installed.stderr);

  const config = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  assert.equal(config.mcpServers.steadfast?.command, "npx");
  assert.deepEqual(config.mcpServers.steadfast?.args, ["-y", "steadfast-docs", "mcp"]);
  assert.equal(
    cli(["mcp", "install", "--platform", "claude", "--check"], root, noAgentPath).status,
    0,
  );
});

test("mcp install preserves existing server settings", () => {
  const root = tempDir();
  assert.equal(cli(["init"], root).status, 0);
  write(
    root,
    ".mcp.json",
    JSON.stringify({
      mcpServers: {
        steadfast: { command: "old", args: ["x"], env: { A: "B" } },
        other: { command: "keep" },
      },
    }),
  );
  write(
    root,
    ".opencode/opencode.json",
    JSON.stringify({
      mcp: {
        servers: {
          steadfast: { type: "local", command: ["old"], environment: { A: "B" } },
          other: { type: "local", command: ["keep"] },
        },
      },
    }),
  );

  assert.equal(
    cli(["mcp", "install", "--platform", "claude"], root, noAgentPath).status,
    0,
  );
  assert.equal(
    cli(["mcp", "install", "--platform", "opencode"], root, noAgentPath).status,
    0,
  );

  const claude = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")) as {
    mcpServers: Record<string, { command: string; env?: Record<string, string> }>;
  };
  assert.equal(claude.mcpServers.steadfast?.command, "npx");
  assert.deepEqual(claude.mcpServers.steadfast?.env, { A: "B" });
  assert.equal(claude.mcpServers.other?.command, "keep");

  const opencode = JSON.parse(
    readFileSync(join(root, ".opencode", "opencode.json"), "utf8"),
  ) as {
    mcp: {
      servers: Record<string, { command: string[]; environment?: Record<string, string> }>;
    };
  };
  assert.deepEqual(opencode.mcp.servers.steadfast?.command, [
    "npx",
    "-y",
    "steadfast-docs",
    "mcp",
  ]);
  assert.deepEqual(opencode.mcp.servers.steadfast?.environment, { A: "B" });
  assert.deepEqual(opencode.mcp.servers.other?.command, ["keep"]);
});

test("mcp install refuses to write through a symlink", () => {
  const root = tempDir();
  assert.equal(cli(["init"], root).status, 0);

  const outside = join(tempDir(), "outside.json");
  writeFileSync(outside, "do not touch\n");
  symlinkSync(outside, join(root, ".mcp.json"));

  const result = cli(["mcp", "install", "--platform", "claude"], root, noAgentPath);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /symlink/);
  assert.equal(readFileSync(outside, "utf8"), "do not touch\n");
});

test("mcp install writes an OpenCode config fallback", () => {
  const root = tempDir();
  assert.equal(cli(["init"], root).status, 0);

  const installed = cli(["mcp", "install", "--platform", "opencode"], root, noAgentPath);
  assert.equal(installed.status, 0, installed.stderr);

  const config = JSON.parse(
    readFileSync(join(root, ".opencode", "opencode.json"), "utf8"),
  ) as { mcp: { servers: Record<string, { type: string; command: string[] }> } };
  assert.equal(config.mcp.servers.steadfast?.type, "local");
  assert.deepEqual(config.mcp.servers.steadfast?.command, [
    "npx",
    "-y",
    "steadfast-docs",
    "mcp",
  ]);
  assert.equal(
    cli(["mcp", "install", "--platform", "opencode", "--check"], root, noAgentPath).status,
    0,
  );
});
