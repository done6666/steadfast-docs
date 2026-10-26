import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  CONFIG_BUDGET_FIELDS,
  CONFIG_FIELDS,
  DECISION_FIELDS,
  GUARD_FIELDS,
  INVARIANT_FIELDS,
  validateConfig,
  validateDecision,
  validateInvariants,
} from "../src/core/validate.js";
import type { Issue } from "../src/types.js";

const HASH = `h1:${"a".repeat(64)}`;

function active(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ADR-0001",
    topic: "http-client",
    scope: "billing",
    status: "active",
    created: "2026-10-26",
    applies_to: ["src/billing/**"],
    decision: "All outbound HTTP goes through src/api/client.ts.",
    verified_by: HASH,
    ...overrides,
  };
}

function codes(issues: Issue[]): string[] {
  return issues.map((issue) => issue.code);
}

test("a minimal active record is valid", () => {
  const result = validateDecision(active(), "ADR-0001.yaml");
  assert.deepEqual(result.issues, []);
  assert.equal(result.value?.id, "ADR-0001");
  assert.equal(result.value?.by, "agent");
});

test("active records require verified_by", () => {
  const result = validateDecision(active({ verified_by: undefined }), "ADR-0001.yaml");
  assert.ok(codes(result.issues).includes("schema/verified-by"));
});

test("unknown fields are rejected", () => {
  const result = validateDecision(active({ notes: "why not" }), "ADR-0001.yaml");
  assert.ok(codes(result.issues).includes("schema/unknown-field"));
});

test("superseded is not a writable status", () => {
  const result = validateDecision(active({ status: "superseded" }), "ADR-0001.yaml");
  assert.ok(codes(result.issues).includes("schema/status"));
});

test("rejected records cannot impose guards", () => {
  const result = validateDecision(
    active({
      status: "rejected",
      why: ["fails the latency budget"],
      guards: [{ deny: "x", instead: "y" }],
      verified_by: undefined,
    }),
    "ADR-0001.yaml",
  );
  assert.ok(codes(result.issues).includes("lint/guard-on-inactive"));
});

test("rejected records require a reason", () => {
  const result = validateDecision(
    active({ status: "rejected", why: undefined, verified_by: undefined }),
    "ADR-0001.yaml",
  );
  assert.ok(codes(result.issues).includes("schema/rejected-reason"));
});

test("scaffold sentinel is rejected", () => {
  const result = validateDecision(active({ decision: "REPLACE_ME" }), "ADR-0001.yaml");
  assert.ok(codes(result.issues).includes("lint/sentinel"));
});

test("field budgets are enforced", () => {
  const result = validateDecision(active({ decision: "x".repeat(201) }), "ADR-0001.yaml");
  assert.ok(codes(result.issues).includes("budget/field-length"));
});

test("applies_to must be repo-relative", () => {
  const result = validateDecision(active({ applies_to: ["/etc/passwd"] }), "ADR-0001.yaml");
  assert.ok(codes(result.issues).includes("schema/glob"));
});

test("duplicate invariant ids are rejected", () => {
  const result = validateInvariants(
    [
      { id: "INV-001", rule: "one" },
      { id: "INV-001", rule: "two" },
    ],
    "invariants.yaml",
    25,
  );
  assert.ok(codes(result.issues).includes("schema/duplicate-id"));
});

test("config merges partial budgets with defaults", () => {
  const result = validateConfig({ version: 1, budgets: { context_tokens: 900 } }, "config.yaml");
  assert.equal(result.value.budgets.context_tokens, 900);
  assert.equal(result.value.budgets.decision_tokens, 160);
  assert.equal(result.value.advisory_ttl_days, 90);
});

test("config bounds match the published schema", () => {
  const low = validateConfig({ version: 1, budgets: { context_tokens: 100 } }, "config.yaml");
  assert.ok(codes(low.issues).includes("budget/range"));

  const high = validateConfig({ version: 1, budgets: { invariants: 100 } }, "config.yaml");
  assert.ok(codes(high.issues).includes("budget/range"));

  const ttl = validateConfig({ version: 1, advisory_ttl_days: 5000 }, "config.yaml");
  assert.ok(codes(ttl.issues).includes("budget/range"));
});

test("retired_docs must stay inside the repository", () => {
  const result = validateConfig({ version: 1, retired_docs: ["../legacy-docs"] }, "config.yaml");
  assert.ok(codes(result.issues).includes("schema/glob"));
});

test("impossible calendar dates are rejected", () => {
  const result = validateDecision(active({ created: "2026-02-31" }), "ADR-0001.yaml");
  assert.ok(codes(result.issues).includes("schema/date"));
});

test("whitespace-only commands are not executable claims", () => {
  const result = validateDecision(active({ enforced_by: "!   " }), "ADR-0001.yaml");
  assert.ok(codes(result.issues).includes("schema/enforced-by"));
});

test("enforced_by cannot escape the repository", () => {
  const result = validateDecision(
    active({ enforced_by: "../../etc/passwd" }),
    "ADR-0001.yaml",
  );
  assert.ok(codes(result.issues).includes("schema/enforced-by"));
});

test("invariant globs cannot escape the repository", () => {
  const result = validateInvariants(
    [{ id: "INV-001", rule: "x", applies_to: ["/etc/passwd"] }],
    "invariants.yaml",
    25,
  );
  assert.ok(codes(result.issues).includes("schema/glob"));
});

test("json schemas stay in sync with the validator", () => {
  const schemaDir = join(process.cwd(), "schema");
  const decision = JSON.parse(
    readFileSync(join(schemaDir, "decision.schema.json"), "utf8"),
  ) as {
    properties: Record<string, unknown>;
    $defs: { guard: { properties: Record<string, unknown> } };
  };
  assert.deepEqual(Object.keys(decision.properties).sort(), [...DECISION_FIELDS].sort());
  assert.deepEqual(
    Object.keys(decision.$defs.guard.properties).sort(),
    [...GUARD_FIELDS].sort(),
  );

  const invariants = JSON.parse(
    readFileSync(join(schemaDir, "invariants.schema.json"), "utf8"),
  ) as { items: { properties: Record<string, unknown> } };
  assert.deepEqual(Object.keys(invariants.items.properties).sort(), [...INVARIANT_FIELDS].sort());

  const config = JSON.parse(readFileSync(join(schemaDir, "config.schema.json"), "utf8")) as {
    properties: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(config.properties).sort(), [...CONFIG_FIELDS].sort());
  assert.ok(CONFIG_BUDGET_FIELDS.length === 4);
});
