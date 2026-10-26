import assert from "node:assert/strict";
import test from "node:test";
import { LedgerRepository } from "../packages/ledger/repository.js";
import { requireTenant, sameTenant } from "../packages/tenancy/index.js";

test("tenant id is required", () => {
  assert.throws(() => requireTenant(""));
  assert.throws(() => requireTenant(undefined));
});

test("tenant comparison is explicit", () => {
  assert.equal(sameTenant("a", "a"), true);
  assert.equal(sameTenant("a", "b"), false);
});

test("entries are tenant-scoped", () => {
  const repository = new LedgerRepository();
  repository.append({
    tenantId: "a",
    accountId: "1",
    amountMinor: 100,
    currency: "USD",
    kind: "charge",
    idempotencyKey: "k1",
  });
  repository.append({
    tenantId: "b",
    accountId: "1",
    amountMinor: 200,
    currency: "USD",
    kind: "charge",
    idempotencyKey: "k2",
  });

  assert.equal(repository.entries("a").length, 1);
  assert.equal(repository.entries("b").length, 1);
  assert.equal(repository.balance("a", "1"), 100);
  assert.equal(repository.balance("b", "1"), 200);
});
