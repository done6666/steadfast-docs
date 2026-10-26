import assert from "node:assert/strict";
import test from "node:test";
import { getProvider } from "../packages/provider/index.js";

test("the stub provider is registered", () => {
  const provider = getProvider("stub");
  assert.equal(provider.name, "stub");
  assert.equal(typeof provider.charge, "function");
});

test("unknown providers are rejected", () => {
  assert.throws(() => getProvider("missing"));
});
