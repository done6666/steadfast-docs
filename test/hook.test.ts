import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CLI, cli, tempDir, write } from "./helpers.js";

const BEGIN = "# steadfast:begin";
const END = "# steadfast:end";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function project(): string {
  const root = tempDir();
  write(root, "src/a.ts", "export const a = 1;\n");
  write(root, "test/a.test.ts", "export {};\n");

  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "test"]);

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
        "Keep the rule.",
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
  return root;
}

test("hook install chains and restores an existing hook", () => {
  const root = project();
  const hookPath = join(root, ".git", "hooks", "pre-commit");
  const backupPath = `${hookPath}.steadfast-original`;
  writeFileSync(hookPath, "#!/bin/sh\necho existing\n");
  chmodSync(hookPath, 0o755);

  const installed = cli(["hook", "install"], root);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(readFileSync(backupPath, "utf8"), /echo existing/);
  const content = readFileSync(hookPath, "utf8");
  assert.ok(content.includes(BEGIN));
  assert.ok(content.includes(END));
  assert.match(content, /pre-commit\.steadfast-original/);
  assert.equal(statSync(hookPath).mode & 0o111, 0o111);
  assert.equal(cli(["hook", "install", "--check"], root).status, 0);

  const again = cli(["hook", "install"], root);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(hookPath, "utf8").split(BEGIN).length - 1, 1);

  const removed = cli(["hook", "remove"], root);
  assert.equal(removed.status, 0, removed.stderr);
  const rest = readFileSync(hookPath, "utf8");
  assert.match(rest, /echo existing/);
  assert.equal(rest.includes(BEGIN), false);
  assert.equal(existsSync(backupPath), false);
  assert.equal(cli(["hook", "install", "--check"], root).status, 1);
});

test("hook remove deletes a hook that only contains the steadfast block", () => {
  const root = project();
  assert.equal(cli(["hook", "install"], root).status, 0);
  const hookPath = join(root, ".git", "hooks", "pre-commit");
  assert.ok(existsSync(hookPath));

  assert.equal(cli(["hook", "remove"], root).status, 0);
  assert.equal(existsSync(hookPath), false);
});

test("hook refuses a hooks directory shared outside the repository", () => {
  const root = project();
  const outside = join(tempDir(), "hooks");
  git(root, ["config", "core.hooksPath", outside]);

  const refused = cli(["hook", "install"], root);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /shared outside this repository/);
  assert.equal(existsSync(join(outside, "pre-commit")), false);
});

test("hook refuses a hooks directory symlinked outside the repository", () => {
  const root = project();
  const outside = tempDir();
  symlinkSync(outside, join(root, ".githooks"));
  git(root, ["config", "core.hooksPath", ".githooks"]);

  const refused = cli(["hook", "install"], root);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /shared outside this repository/);
  assert.equal(existsSync(join(outside, "pre-commit")), false);
});

test("hook honors core.hooksPath", () => {
  const root = project();
  git(root, ["config", "core.hooksPath", ".husky"]);

  const installed = cli(["hook", "install"], root);
  assert.equal(installed.status, 0, installed.stderr);
  assert.ok(existsSync(join(root, ".husky", "pre-commit")));
  assert.equal(cli(["hook", "install", "--check"], root).status, 0);

  assert.equal(cli(["hook", "remove"], root).status, 0);
  assert.equal(existsSync(join(root, ".husky", "pre-commit")), false);
});

test("hook chains a non-shell hook without rewriting it", () => {
  const root = project();
  const hookPath = join(root, ".git", "hooks", "pre-commit");
  const backupPath = `${hookPath}.steadfast-original`;
  const python = "#!/usr/bin/env python3\nprint('hi')\n";
  writeFileSync(hookPath, python);
  chmodSync(hookPath, 0o755);

  const installed = cli(["hook", "install"], root);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(readFileSync(backupPath, "utf8"), python);

  assert.equal(cli(["hook", "remove"], root).status, 0);
  assert.equal(readFileSync(hookPath, "utf8"), python);
});

test("hook preserves a hook without a shebang", () => {
  const root = project();
  const hookPath = join(root, ".git", "hooks", "pre-commit");
  writeFileSync(hookPath, "echo existing\n");
  chmodSync(hookPath, 0o755);

  assert.equal(cli(["hook", "install"], root).status, 0);
  assert.equal(
    readFileSync(`${hookPath}.steadfast-original`, "utf8"),
    "echo existing\n",
  );
  assert.equal(cli(["hook", "remove"], root).status, 0);
  assert.equal(readFileSync(hookPath, "utf8"), "echo existing\n");
});

test("hook runs the chained hook before check, even if it exits early", () => {
  const root = project();
  const hookPath = join(root, ".git", "hooks", "pre-commit");
  writeFileSync(hookPath, "#!/bin/sh\nexit 0\n");
  chmodSync(hookPath, 0o755);

  assert.equal(cli(["hook", "install"], root).status, 0);
  const content = readFileSync(hookPath, "utf8");
  assert.ok(content.indexOf("pre-commit.steadfast-original") < content.indexOf("run_steadfast check"));
  assert.match(readFileSync(`${hookPath}.steadfast-original`, "utf8"), /exit 0/);
});

test("check --staged ignores the chained hook backup", () => {
  const root = project();
  assert.equal(
    cli(
      [
        "new",
        "--scope",
        "global",
        "--topic",
        "all-files",
        "--decision",
        "Every file is governed.",
        "--applies-to",
        "**",
        "--status",
        "active",
        "--enforced-by",
        "test/a.test.ts",
      ],
      root,
    ).status,
    0,
  );
  write(root, ".gitignore", "node_modules/\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base"]);

  git(root, ["config", "core.hooksPath", ".husky"]);
  write(root, ".husky/pre-commit", "#!/bin/sh\necho existing\n");
  chmodSync(join(root, ".husky", "pre-commit"), 0o755);
  assert.equal(cli(["hook", "install"], root).status, 0);
  assert.equal(cli(["verify", "ADR-0002", "--assume"], root).status, 0);

  git(root, ["add", ".husky/pre-commit", ".steadfast"]);
  const checked = cli(["check", "--strict", "--staged"], root);
  assert.equal(checked.status, 0, checked.stderr);
});

test("the hook runs the chained hook and then the check", () => {
  const root = project();
  const bin = join(root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, "steadfast");
  writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`);
  chmodSync(shim, 0o755);

  write(root, ".gitignore", "node_modules/\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base"]);

  const hookPath = join(root, ".git", "hooks", "pre-commit");
  writeFileSync(
    hookPath,
    `#!/bin/sh\ntouch "$(dirname "$0")/original-ran"\nexit 0\n`,
  );
  chmodSync(hookPath, 0o755);
  assert.equal(cli(["hook", "install"], root).status, 0);

  const run = spawnSync(hookPath, [], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.ok(existsSync(join(root, ".git", "hooks", "original-ran")));
});

test("the pre-commit hook blocks a stale commit and passes after verify", () => {
  const root = project();
  const bin = join(root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, "steadfast");
  writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`);
  chmodSync(shim, 0o755);

  write(root, ".gitignore", "node_modules/\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base"]);
  assert.equal(cli(["hook", "install"], root).status, 0);

  write(root, "src/a.ts", "export const a = 2;\n");
  git(root, ["add", "src/a.ts"]);
  const blocked = spawnSync("git", ["commit", "-m", "stale"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(blocked.status, 0);
  assert.match(`${blocked.stdout}${blocked.stderr}`, /freshness|verify/);

  assert.equal(cli(["verify", "ADR-0001", "--assume"], root).status, 0);
  git(root, ["add", "-A"]);
  const passed = spawnSync("git", ["commit", "-m", "fixed"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(passed.status, 0, `${passed.stdout}${passed.stderr}`);
  assert.equal(git(root, ["log", "-1", "--format=%s"]), "fixed");
});

test("the hook blocks a verify that was not staged", () => {
  const root = project();
  const bin = join(root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, "steadfast");
  writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`);
  chmodSync(shim, 0o755);

  write(root, ".gitignore", "node_modules/\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base"]);
  assert.equal(cli(["hook", "install"], root).status, 0);

  write(root, "src/a.ts", "export const a = 2;\n");
  git(root, ["add", "src/a.ts"]);
  assert.equal(cli(["verify", "ADR-0001", "--assume"], root).status, 0);

  const blocked = spawnSync("git", ["commit", "-m", "unstaged record"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(blocked.status, 0);
  assert.match(`${blocked.stdout}${blocked.stderr}`, /git\/unstaged|working tree differs/);

  git(root, ["add", "-A"]);
  const passed = spawnSync("git", ["commit", "-m", "staged record"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(passed.status, 0, `${passed.stdout}${passed.stderr}`);
});

test("the hook blocks an untracked successor record", () => {
  const root = project();
  const bin = join(root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, "steadfast");
  writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`);
  chmodSync(shim, 0o755);

  write(root, ".gitignore", "node_modules/\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base"]);
  assert.equal(cli(["hook", "install"], root).status, 0);

  write(root, "src/a.ts", "export const a = 2;\n");
  git(root, ["add", "src/a.ts"]);
  assert.equal(cli(["verify", "ADR-0001", "--assume"], root).status, 0);
  assert.equal(
    cli(["supersede", "ADR-0001", "--decision", "Rule two."], root).status,
    0,
  );

  git(root, ["add", "-u"]);
  const blocked = spawnSync("git", ["commit", "-m", "missing successor"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(blocked.status, 0);
  assert.match(
    `${blocked.stdout}${blocked.stderr}`,
    /ADR-0002\.yaml|working tree and index disagree/,
  );

  git(root, ["add", "-A"]);
  const passed = spawnSync("git", ["commit", "-m", "successor"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(passed.status, 0, `${passed.stdout}${passed.stderr}`);
});

test("the hook works when the project is below the git root", () => {
  const gitRootDir = tempDir();
  write(gitRootDir, "pkg/src/a.ts", "export const a = 1;\n");
  write(gitRootDir, "pkg/test/a.test.ts", "export {};\n");
  write(gitRootDir, "pkg/.gitignore", "node_modules/\n");

  git(gitRootDir, ["init", "-q"]);
  git(gitRootDir, ["config", "user.email", "test@example.com"]);
  git(gitRootDir, ["config", "user.name", "test"]);

  const root = join(gitRootDir, "pkg");
  assert.equal(cli(["init", "--dir", "."], root).status, 0);
  assert.equal(
    cli(
      [
        "new",
        "--scope",
        "global",
        "--topic",
        "rule",
        "--decision",
        "Keep the rule.",
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

  const bin = join(root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, "steadfast");
  writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`);
  chmodSync(shim, 0o755);

  git(gitRootDir, ["config", "core.hooksPath", ".husky"]);
  assert.equal(cli(["hook", "install"], root).status, 0);
  assert.ok(existsSync(join(gitRootDir, ".husky", "pre-commit")));
  assert.equal(cli(["hook", "install", "--check"], root).status, 0);
  git(gitRootDir, ["add", "-A"]);
  git(gitRootDir, ["commit", "-q", "-m", "base"]);

  write(root, "src/a.ts", "export const a = 2;\n");
  git(gitRootDir, ["add", "pkg/src/a.ts"]);
  assert.equal(cli(["verify", "ADR-0001", "--assume"], root).status, 0);
  git(gitRootDir, ["add", "-A"]);

  const passed = spawnSync("git", ["commit", "-m", "subdir"], {
    cwd: gitRootDir,
    encoding: "utf8",
  });
  assert.equal(passed.status, 0, `${passed.stdout}${passed.stderr}`);
});
