import { checkCommand } from "./commands/check.js";
import { contextCommand } from "./commands/context.js";
import { doctorCommand } from "./commands/doctor.js";
import { explainCommand } from "./commands/explain.js";
import { hookCommand } from "./commands/hook.js";
import { initCommand } from "./commands/init.js";
import { mcpCommand } from "./commands/mcp.js";
import { newCommand } from "./commands/new.js";
import { retireCommand } from "./commands/retire.js";
import { skillCommand } from "./commands/skill.js";
import { supersedeCommand } from "./commands/supersede.js";
import { verifyCommand } from "./commands/verify.js";
import { paint, write, writeError } from "./output.js";
import { VERSION } from "./version.js";

function printHelp(): void {
  write(`${paint.bold("steadfast")} ${VERSION} - normative project memory for coding agents`);
  write("");
  write("Usage: steadfast <command> [options]");
  write("");
  write("  init       scaffold .steadfast/ and the AGENTS.md contract");
  write("  context    compile a token-budgeted memory pack for paths or a scope");
  write("  check      validate the memory graph, freshness, paths and budgets");
  write("  new        append a decision record");
  write("  explain    print one record's metadata");
  write("  supersede  append a successor to an active record");
  write("  verify     recompute freshness fingerprints");
  write("  retire     delete legacy docs and record them as retired");
  write("  skill      install the canonical agent loop");
  write("  mcp        start the MCP server or register it with an agent");
  write("  hook       install the pre-commit check");
  write("  doctor     diagnose the agent contract and environment");
  write("  version    print the version");
  write("");
  write("Run `steadfast <command> --help` for command options.");
}

export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }

  switch (command) {
    case "init":
      return initCommand(rest);
    case "new":
      return newCommand(rest);
    case "explain":
      return explainCommand(rest);
    case "supersede":
      return supersedeCommand(rest);
    case "context":
      return contextCommand(rest);
    case "check":
      return checkCommand(rest);
    case "verify":
      return verifyCommand(rest);
    case "retire":
      return retireCommand(rest);
    case "skill":
      return skillCommand(rest);
    case "mcp":
      return mcpCommand(rest);
    case "hook":
      return hookCommand(rest);
    case "doctor":
      return doctorCommand(rest);
    case "version":
    case "--version":
    case "-v":
      write(VERSION);
      return 0;
    default:
      writeError(`error: unknown command "${command}"`);
      printHelp();
      return 2;
  }
}
