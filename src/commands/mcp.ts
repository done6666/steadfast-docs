import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { insideRoot } from "../core/paths.js";
import { findProjectRoot } from "../core/store.js";
import { paint, write, writeError } from "../output.js";
import { startMcpServer } from "../mcp/server.js";

const SERVER_NAME = "steadfast";
const COMMAND = ["npx", "-y", "steadfast-docs", "mcp"];
const OPENCODE_SCHEMA = "https://opencode.ai/config.json";

type Platform = "opencode" | "claude";

function printHelp(): void {
  write("steadfast mcp                        start the stdio MCP server");
  write("steadfast mcp install [options]      register the server with an agent");
  write("");
  write("  --platform opencode|claude|auto    default: auto");
  write("  --global                           user-level configuration");
  write("  --check                            report whether the server is configured");
  write("  --print                            print the config or command, do not write");
  return;
}

function commandExists(name: string): boolean {
  const finder = process.platform === "win32" ? "where" : "which";
  return spawnSync(finder, [name], { stdio: "ignore" }).status === 0;
}

function targetProblem(
  root: string,
  path: string,
  allowOutside = false,
): string | undefined {
  try {
    if (!allowOutside) {
      const rootReal = realpathSync(root);
      let parent = dirname(path);
      while (!existsSync(parent)) {
        const next = dirname(parent);
        if (next === parent) break;
        parent = next;
      }
      if (!insideRoot(rootReal, realpathSync(parent))) {
        return `error: ${path} resolves outside ${root}; refusing to write`;
      }
    }
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      return `error: ${path} is a symlink; refusing to write through it`;
    }
    return undefined;
  } catch (error) {
    return `error: cannot resolve ${path}: ${(error as Error).message}`;
  }
}

function writeConfig(
  root: string,
  path: string,
  config: Record<string, unknown>,
  allowOutside = false,
): string {
  const problem = targetProblem(root, path, allowOutside);
  if (problem !== undefined) return problem;

  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(temporary, path);
  return path;
}

function opencodeConfigPaths(root: string, global: boolean): string[] {
  if (global) {
    const base = join(homedir(), ".config", "opencode");
    return [join(base, "opencode.json"), join(base, "opencode.jsonc")];
  }
  return [
    join(root, "opencode.json"),
    join(root, "opencode.jsonc"),
    join(root, ".opencode", "opencode.json"),
    join(root, ".opencode", "opencode.jsonc"),
  ];
}

function readJson(path: string): Record<string, unknown> | string {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    return `error: ${path} is not plain JSON (${(error as Error).message}); run: opencode mcp add steadfast -- npx -y steadfast-docs mcp`;
  }
}

function writeOpenCodeConfig(root: string, global: boolean): string {
  const path = global
    ? join(homedir(), ".config", "opencode", "opencode.json")
    : join(root, ".opencode", "opencode.json");

  const problem = targetProblem(root, path, global);
  if (problem !== undefined) return problem;

  let config: Record<string, unknown> = {};
  if (existsSync(path)) {
    const parsed = readJson(path);
    if (typeof parsed === "string") return parsed;
    config = parsed;
  }

  config.$schema ??= OPENCODE_SCHEMA;
  const mcp = (config.mcp as Record<string, unknown> | undefined) ?? {};
  const servers = (mcp.servers as Record<string, unknown> | undefined) ?? {};
  const existing = servers[SERVER_NAME];
  servers[SERVER_NAME] = {
    ...(typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {}),
    type: "local",
    command: COMMAND,
  };
  mcp.servers = servers;
  config.mcp = mcp;

  return writeConfig(root, path, config, global);
}

function installOpenCode(root: string, global: boolean): number {
  if (commandExists("opencode")) {
    const args = [
      "mcp",
      "add",
      SERVER_NAME,
      ...(global ? ["--global"] : []),
      "--",
      ...COMMAND,
    ];
    const result = spawnSync("opencode", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PWD: root },
      shell: process.platform === "win32",
    });
    if (result.status === 0) {
      write(`${paint.green("installed")} OpenCode MCP server "${SERVER_NAME}"`);
      write(`next: opencode mcp list`);
      return 0;
    }
    writeError(
      `warning: opencode mcp add failed; falling back to config\n${result.stderr ?? ""}`,
    );
  }

  const path = writeOpenCodeConfig(root, global);
  if (path.startsWith("error:")) {
    writeError(path);
    return 2;
  }
  write(`${paint.green("installed")} ${path}`);
  write(`next: restart OpenCode and run "opencode mcp list"`);
  return 0;
}

function claudeConfigPath(root: string): string {
  return join(root, ".mcp.json");
}

function installClaude(root: string, global: boolean): number {
  if (commandExists("claude")) {
    const result = spawnSync(
      "claude",
      [
        "mcp",
        "add",
        "--transport",
        "stdio",
        "--scope",
        global ? "user" : "project",
        SERVER_NAME,
        "--",
        ...COMMAND,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, PWD: root },
        shell: process.platform === "win32",
      },
    );
    if (result.status === 0) {
      write(`${paint.green("installed")} Claude MCP server "${SERVER_NAME}"`);
      write("next: run /mcp in Claude Code and approve the project server");
      return 0;
    }
    writeError(`warning: claude mcp add failed; falling back to config\n${result.stderr ?? ""}`);
  }

  if (global) {
    writeError("error: the claude CLI is required for --global");
    return 2;
  }

  const path = claudeConfigPath(root);
  const problem = targetProblem(root, path);
  if (problem !== undefined) {
    writeError(problem);
    return 2;
  }

  let config: Record<string, unknown> = {};
  if (existsSync(path)) {
    const parsed = readJson(path);
    if (typeof parsed === "string") {
      writeError(parsed);
      return 2;
    }
    config = parsed;
  }

  const servers = (config.mcpServers as Record<string, unknown> | undefined) ?? {};
  const existing = servers[SERVER_NAME];
  servers[SERVER_NAME] = {
    ...(typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {}),
    command: COMMAND[0],
    args: COMMAND.slice(1),
  };
  config.mcpServers = servers;
  const written = writeConfig(root, path, config);
  if (written.startsWith("error:")) {
    writeError(written);
    return 2;
  }
  write(`${paint.green("installed")} ${written}`);
  write("next: run /mcp in Claude Code and approve the project server");
  return 0;
}

function checkOpenCode(root: string, global: boolean): number {
  for (const path of opencodeConfigPaths(root, global)) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    if (
      text.includes(`"${SERVER_NAME}"`) &&
      text.includes("steadfast-docs") &&
      text.includes("mcp")
    ) {
      write(`${paint.green("ok")} ${path}`);
      return 0;
    }
  }
  writeError("missing: the steadfast MCP server is not configured");
  writeError(`fix: steadfast mcp install --platform opencode${global ? " --global" : ""}`);
  return 1;
}

function checkClaude(root: string, global: boolean): number {
  if (global && commandExists("claude")) {
    const result = spawnSync("claude", ["mcp", "get", SERVER_NAME], {
      cwd: root,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    if (result.status === 0) {
      write(`${paint.green("ok")} claude user scope`);
      return 0;
    }
  }

  const path = global ? join(homedir(), ".claude.json") : claudeConfigPath(root);
  if (!existsSync(path)) {
    writeError(`missing: ${path}`);
    writeError(`fix: steadfast mcp install --platform claude${global ? " --global" : ""}`);
    return 1;
  }
  const parsed = readJson(path);
  if (typeof parsed === "string") {
    writeError(parsed);
    return 1;
  }
  const servers = parsed.mcpServers as Record<string, unknown> | undefined;
  if (servers?.[SERVER_NAME] === undefined) {
    writeError(`missing: mcpServers.${SERVER_NAME} in ${path}`);
    return 1;
  }
  write(`${paint.green("ok")} ${path}`);
  return 0;
}

function detectPlatform(root: string): Platform {
  if (existsSync(join(root, ".opencode")) || commandExists("opencode")) return "opencode";
  if (existsSync(join(root, ".claude")) || commandExists("claude")) return "claude";
  return "opencode";
}

function printConfig(platform: Platform, global: boolean): void {
  if (platform === "opencode") {
    write(
      `opencode mcp add ${SERVER_NAME}${global ? " --global" : ""} -- npx -y steadfast-docs mcp`,
    );
    write("");
    write(
      JSON.stringify(
        {
          $schema: OPENCODE_SCHEMA,
          mcp: {
            servers: {
              [SERVER_NAME]: { type: "local", command: COMMAND },
            },
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  write(
    `claude mcp add --transport stdio --scope ${global ? "user" : "project"} ${SERVER_NAME} -- npx -y steadfast-docs mcp`,
  );
  write("");
  write(
    JSON.stringify(
      {
        mcpServers: {
          [SERVER_NAME]: { command: COMMAND[0], args: COMMAND.slice(1) },
        },
      },
      null,
      2,
    ),
  );
}

export async function mcpCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      platform: { type: "string", default: "auto" },
      global: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      print: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    printHelp();
    return 0;
  }

  if (positionals.length === 0) {
    startMcpServer();
    return 0;
  }

  if (positionals.length > 1 || positionals[0] !== "install") {
    writeError("error: usage: steadfast mcp [install] [options]");
    return 2;
  }

  if (values.global && values.root !== undefined) {
    writeError("error: use either --global or --root, not both");
    return 2;
  }

  const root = values.global
    ? homedir()
    : values.root !== undefined
      ? resolve(values.root)
      : (findProjectRoot(process.cwd()) ?? process.cwd());

  const platform =
    values.platform === "auto" ? detectPlatform(root) : (values.platform as Platform);
  if (platform !== "opencode" && platform !== "claude") {
    writeError(`error: unsupported platform "${values.platform}"; use opencode or claude`);
    return 2;
  }

  if (values.print) {
    printConfig(platform, values.global);
    return 0;
  }

  if (values.check) {
    return platform === "claude"
      ? checkClaude(root, values.global)
      : checkOpenCode(root, values.global);
  }

  return platform === "claude"
    ? installClaude(root, values.global)
    : installOpenCode(root, values.global);
}
