import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokens } from "../src/core/tokens.js";

test("empty input costs nothing", () => {
  assert.equal(estimateTokens(""), 0);
});

test("estimates grow with content", () => {
  const small = estimateTokens("one short rule");
  const large = estimateTokens("one short rule ".repeat(40));
  assert.ok(large > small);
});

test("estimate is conservative for yaml-like text", () => {
  const text = '  - id: ADR-0001\n    deny: "src/** fetch"\n    instead: "src/api.ts"';
  const tokens = estimateTokens(text);
  assert.ok(tokens >= Math.ceil(text.length / 4));
});

test("a 90-token record stays under the default 160-token budget", () => {
  const record = [
    "id: ADR-0012",
    "topic: billing.http-client",
    "scope: billing",
    'decision: "All outbound HTTP goes through src/api/client.ts."',
    'why: ["Retry and timeout live in one place."]',
    'enforced_by: "test/api/client.contract.test.ts"',
  ].join("\n");
  assert.ok(estimateTokens(record) < 160);
});
