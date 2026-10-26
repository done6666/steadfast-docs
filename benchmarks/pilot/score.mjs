import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

function run(command, args, cwd, timeout = 300_000) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1", PWD: cwd },
  });
  return {
    ok: result.status === 0,
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: result.error?.code === "ETIMEDOUT",
  };
}

function walk(root, out = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

function truncate(text, max = 2_000) {
  return text.length <= max ? text : `${text.slice(0, max)}\n...`;
}

function estimateTokens(text) {
  return text.length === 0 ? 0 : Math.ceil(text.length / 3.4);
}

function changedPaths(dir) {
  const result = run("git", ["status", "--porcelain", "--untracked-files=all"], dir);
  return result.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      let value = line.slice(3).trim();
      if (value.includes(" -> ")) value = value.split(" -> ")[1];
      if (value.startsWith('"') && value.endsWith('"')) {
        try {
          value = JSON.parse(value);
        } catch {
          value = value.slice(1, -1);
        }
      }
      return value;
    });
}

export function scoreRun({ dir, task, mode, base, here }) {
  const visibleFiles = readdirSync(join(dir, "test"))
    .filter((name) => name.endsWith(".test.js"))
    .map((name) => join("test", name));

  const visible = run("node", ["--test", ...visibleFiles], dir);

  let trap = null;
  if (task.trap !== null && task.trap !== undefined) {
    mkdirSync(join(dir, "test", "traps"), { recursive: true });
    cpSync(join(here, "traps", task.trap), join(dir, "test", "traps", task.trap));
    trap = run("node", ["--test", join("test", "traps", task.trap)], dir);
  }

  const cli = join(dir, "node_modules", ".bin", "steadfast");
  let check = null;
  let contextTokens = null;
  let included = [];
  let packageBaselineTokens = null;

  if (mode !== "baseline") {
    check = run(cli, ["check", "--strict", "--diff", base], dir);
    const context = run(cli, ["context", ...task.context, "--json"], dir);
    if (context.ok) {
      const parsed = JSON.parse(context.stdout);
      contextTokens = parsed.tokens;
      included = [
        ...(parsed.included?.decisions ?? []),
        ...(parsed.included?.rejected ?? []),
      ];
    } else {
      contextTokens = null;
    }
  } else {
    const docs = walk(join(dir, "legacy-docs")).filter((path) => path.endsWith(".md"));
    packageBaselineTokens = docs.reduce(
      (sum, path) => sum + estimateTokens(readFileSync(path, "utf8")),
      0,
    );
  }

  const missingRules =
    mode !== "baseline" && task.kind !== "memory"
      ? task.related.filter((id) => !included.includes(id))
      : [];

  const changed = changedPaths(dir);
  const scopeViolations = changed.filter(
    (path) => !task.allowed.some((prefix) => path === prefix || path.startsWith(prefix)),
  );

  let specialOk = true;
  let special = {};

  if (task.kind === "memory") {
    const files = readdirSync(join(dir, ".steadfast", "decisions")).filter((name) =>
      name.endsWith(".yaml"),
    );
    const records = files.map((name) => {
      try {
        return parse(readFileSync(join(dir, ".steadfast", "decisions", name), "utf8"));
      } catch {
        return undefined;
      }
    });
    const successor = records.find(
      (record) =>
        record?.status === "active" &&
        record.topic === "reconciliation" &&
        Array.isArray(record.supersedes) &&
        record.supersedes.includes("ADR-0016"),
    );
    specialOk = successor !== undefined;
    special = { successor: successor?.id ?? null };
  }

  if (task.kind === "deps") {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const pkgOk =
      typeof pkg.devDependencies?.prettier === "string" &&
      typeof pkg.scripts?.format === "string";

    let decisionAdded = true;
    if (mode !== "baseline") {
      const diff = execFileSync("git", ["diff", "--name-status", base, "--", ".steadfast/decisions"], {
        cwd: dir,
        encoding: "utf8",
      });
      const untracked = execFileSync(
        "git",
        ["ls-files", "--others", "--exclude-standard", "--", ".steadfast/decisions"],
        { cwd: dir, encoding: "utf8" },
      )
        .split("\n")
        .filter(Boolean);
      decisionAdded =
        diff.split("\n").some((line) => line.startsWith("A\t")) || untracked.length > 0;
    }

    specialOk = pkgOk && decisionAdded;
    special = { packageJson: pkgOk, decisionAdded };
  }

  const visibleOk = visible.ok;
  const trapOk = trap === null ? true : trap.ok;
  const checkOk = check === null ? true : check.ok;

  return {
    task: task.id,
    title: task.title,
    mode,
    pass: visibleOk && trapOk && checkOk && scopeViolations.length === 0 && specialOk,
    visible: { ok: visibleOk, status: visible.status, output: truncate(visible.stdout + visible.stderr) },
    trap: trap === null ? null : { ok: trapOk, status: trap.status, output: truncate(trap.stdout + trap.stderr) },
    check: check === null ? null : { ok: checkOk, status: check.status, output: truncate(check.stdout + check.stderr) },
    specialOk,
    special,
    contextTokens,
    baselineTokens: packageBaselineTokens,
    missingRules,
    related: task.related,
    scopeViolations,
    changed,
    dir,
  };
}
