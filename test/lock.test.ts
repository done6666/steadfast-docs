import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { cli, cliAsync, tempDir, write } from "./helpers.js";

test("new reclaims a lock owned by a dead process", () => {
  const root = tempDir();
  write(root, "src/a.ts", "a");
  assert.equal(cli(["init"], root).status, 0);

  const lock = join(root, ".steadfast", "decisions", ".lock");
  mkdirSync(lock);
  writeFileSync(
    join(lock, "owner.json"),
    JSON.stringify({ pid: 2_147_483_647, token: "dead" }),
  );

  const result = cli(
    [
      "new",
      "--scope",
      "global",
      "--topic",
      "rule",
      "--decision",
      "A rule.",
      "--applies-to",
      "src/**",
      "--status",
      "draft",
    ],
    root,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(lock), false);
});

test("new releases the lock when validation fails", () => {
  const root = tempDir();
  write(root, "src/a.ts", "a");
  assert.equal(cli(["init"], root).status, 0);

  const lock = join(root, ".steadfast", "decisions", ".lock");
  const result = cli(
    [
      "new",
      "--scope",
      "global",
      "--topic",
      "rule",
      "--decision",
      "x".repeat(201),
      "--applies-to",
      "src/**",
      "--status",
      "draft",
    ],
    root,
  );

  assert.equal(result.status, 2);
  assert.equal(existsSync(lock), false);
});

test("parallel new keeps one active rule per topic", async () => {
  const root = tempDir();
  write(root, "src/a.ts", "a");
  assert.equal(cli(["init"], root).status, 0);

  const args = [
    "new",
    "--scope",
    "global",
    "--topic",
    "race",
    "--decision",
    "Race rule.",
    "--applies-to",
    "src/**",
    "--status",
    "active",
    "--enforced-by",
    "src/a.ts",
  ];

  const results = await Promise.all([cliAsync(args, root), cliAsync(args, root)]);
  assert.deepEqual(
    results.map((result) => result.status).sort(),
    [0, 2],
    results.map((result) => result.stderr).join("\n"),
  );

  const files = readdirSync(join(root, ".steadfast", "decisions")).filter((name) =>
    name.endsWith(".yaml"),
  );
  assert.equal(files.length, 1);
});
