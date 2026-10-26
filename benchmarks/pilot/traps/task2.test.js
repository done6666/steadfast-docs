import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { getProvider } from "../../packages/provider/index.js";

function javascriptFiles(directory, out = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) javascriptFiles(path, out);
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(path);
  }
  return out;
}

test("the acme provider is registered behind the port", () => {
  const provider = getProvider("acme");
  assert.equal(provider.name, "acme");
  assert.equal(typeof provider.charge, "function");
});

test("no provider bypasses the shared HTTP client", () => {
  const packages = join(process.cwd(), "packages");
  const allowed = join(packages, "http", "client.js");

  const offenders = javascriptFiles(packages)
    .filter((file) => file !== allowed)
    .filter((file) => {
      const text = readFileSync(file, "utf8");
      return /\bfetch\s*\(/.test(text) || /\baxios\b/.test(text);
    });

  assert.deepEqual(offenders, []);
});
