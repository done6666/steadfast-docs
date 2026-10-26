import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import type { Decision, Invariant, Issue, Loaded } from "../types.js";
import {
  DEFAULT_CONFIG,
  validateConfig,
  validateDecision,
  validateInvariants,
} from "./validate.js";
import { insideRoot } from "./paths.js";

export function findProjectRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".steadfast"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readYaml(path: string): { value?: unknown; issue?: Issue } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return {
      issue: {
        severity: "error",
        code: "fs/read",
        message: `cannot read file: ${(error as Error).message}`,
        file: path,
      },
    };
  }

  try {
    return { value: parse(text) };
  } catch (error) {
    const line = (error as { linePos?: Array<{ line: number }> }).linePos?.[0]?.line;
    const location = line === undefined ? "" : ` (line ${line})`;
    return {
      issue: {
        severity: "error",
        code: "yaml/parse",
        message: `${(error as Error).message.split("\n")[0]}${location}`,
        file: path,
      },
    };
  }
}

function listRecordFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .filter((name): name is string => typeof name === "string")
    .filter((name) => /\.ya?ml$/.test(name))
    .filter((name) => !name.split(/[\\/]/).some((part) => part.startsWith("_")))
    .map((name) => join(dir, name))
    .sort();
}

export function loadProject(root: string): Loaded {
  const issues: Issue[] = [];
  const rel = (path: string) => relative(root, path).replace(/\\/g, "/");

  const steadfastDir = join(root, ".steadfast");
  if (existsSync(steadfastDir) && !insideRoot(root, steadfastDir)) {
    issues.push({
      severity: "error",
      code: "fs/outside-root",
      message: ".steadfast resolves outside the project",
    });
    return {
      root,
      config: DEFAULT_CONFIG,
      invariants: [],
      decisions: [],
      files: new Map(),
      issues,
    };
  }

  let config = DEFAULT_CONFIG;
  const configPath = join(root, ".steadfast", "config.yaml");
  if (existsSync(configPath)) {
    const parsed = readYaml(configPath);
    if (parsed.issue) {
      parsed.issue.file = rel(configPath);
      issues.push(parsed.issue);
    } else {
      const result = validateConfig(parsed.value, rel(configPath));
      config = result.value;
      issues.push(...result.issues);
    }
  } else {
    issues.push({
      severity: "error",
      code: "project/no-config",
      message: "missing .steadfast/config.yaml",
      fix: "run: steadfast init",
    });
  }

  let invariants: Invariant[] = [];
  const invariantsPath = join(root, ".steadfast", "invariants.yaml");
  if (existsSync(invariantsPath)) {
    const parsed = readYaml(invariantsPath);
    if (parsed.issue) {
      parsed.issue.file = rel(invariantsPath);
      issues.push(parsed.issue);
    } else {
      const result = validateInvariants(parsed.value, rel(invariantsPath), config.budgets.invariants);
      invariants = result.values;
      issues.push(...result.issues);
    }
  } else {
    issues.push({
      severity: "error",
      code: "project/no-invariants",
      message: "missing .steadfast/invariants.yaml",
      fix: "run: steadfast init",
    });
  }

  const decisions: Decision[] = [];
  const files = new Map<string, string>();
  const decisionsDir = join(root, ".steadfast", "decisions");

  for (const path of listRecordFiles(decisionsDir)) {
    const relativePath = rel(path);
    if (!insideRoot(root, path)) {
      issues.push({
        severity: "error",
        code: "fs/outside-root",
        message: "decision file resolves outside the project",
        file: relativePath,
      });
      continue;
    }
    const parsed = readYaml(path);
    if (parsed.issue) {
      parsed.issue.file = relativePath;
      issues.push(parsed.issue);
      continue;
    }

    const result = validateDecision(parsed.value, relativePath);
    issues.push(...result.issues);
    if (!result.value) continue;

    const decision = result.value;
    if (files.has(decision.id)) {
      issues.push({
        severity: "error",
        code: "schema/duplicate-id",
        message: `duplicate decision id "${decision.id}" (also in ${files.get(decision.id)})`,
        file: relativePath,
        id: decision.id,
        fix: "ids are immutable; allocate a new id with: steadfast new",
      });
      continue;
    }

    files.set(decision.id, relativePath);
    decisions.push(decision);
  }

  return { root, config, invariants, decisions, files, issues };
}
