import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function javascriptFiles(directory, out = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) javascriptFiles(path, out);
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(path);
  }
  return out;
}

test("only the shared client calls fetch", () => {
  const packages = join(process.cwd(), "packages");
  const allowed = join(packages, "http", "client.js");
  const offenders = javascriptFiles(packages)
    .filter((file) => file !== allowed)
    .filter((file) => /\bfetch\s*\(/.test(readFileSync(file, "utf8")));

  assert.deepEqual(offenders, []);
});
