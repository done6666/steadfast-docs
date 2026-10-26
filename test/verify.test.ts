import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { cli, tempDir, write } from "./helpers.js";

test("verify --all refuses --run", () => {
  const root = tempDir();
  write(root, "src/a.ts", "a");
  assert.equal(cli(["init"], root).status, 0);

  const result = cli(["verify", "--all", "--run", "true"], root);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /explicit ids/);
});

test("verify --all does not trust !commands without --trust", () => {
  const root = tempDir();
  write(root, "src/a.ts", "a");
  assert.equal(cli(["init"], root).status, 0);

  const created = cli(
    [
      "new",
      "--scope",
      "global",
      "--topic",
      "exec",
      "--decision",
      "Executable rule.",
      "--applies-to",
      "src/**",
      "--status",
      "active",
      "--enforced-by",
      "!true",
    ],
    root,
  );
  assert.equal(created.status, 0, created.stderr);

  const file = join(root, ".steadfast", "decisions", "ADR-0001.yaml");
  const before = readFileSync(file, "utf8");

  const denied = cli(["verify", "--all", "--assume"], root);
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /--trust/);
  assert.equal(readFileSync(file, "utf8"), before);

  const trusted = cli(["verify", "--all", "--assume", "--trust"], root);
  assert.equal(trusted.status, 0, trusted.stderr);
});
