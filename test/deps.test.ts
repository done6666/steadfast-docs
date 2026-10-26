import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ALLOWED_RUNTIME = new Set(["yaml"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

test("runtime dependencies stay minimal", () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const runtime = Object.keys(pkg.dependencies ?? {}).sort();
  assert.deepEqual(runtime, [...ALLOWED_RUNTIME].sort());
});

test("source code imports nothing outside the allowlist", () => {
  const specifiers = new Set<string>();
  for (const file of sourceFiles(join(process.cwd(), "src"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/from\s+"([^"]+)"/g)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
      specifiers.add(specifier);
    }
  }
  for (const specifier of specifiers) {
    const root = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
    assert.ok(ALLOWED_RUNTIME.has(root), `unexpected runtime import: ${specifier}`);
  }
});
