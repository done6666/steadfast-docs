import assert from "node:assert/strict";
import test from "node:test";
import { LedgerRepository } from "../packages/ledger/repository.js";

test("append is idempotent per tenant and key", () => {
  const repository = new LedgerRepository();
  const first = repository.append({
    tenantId: "a",
    accountId: "1",
    amountMinor: 100,
    currency: "USD",
    kind: "charge",
    idempotencyKey: "k1",
  });
  const second = repository.append({
    tenantId: "a",
    accountId: "1",
    amountMinor: 999,
    currency: "USD",
    kind: "charge",
    idempotencyKey: "k1",
  });

  assert.equal(second.seq, first.seq);
  assert.equal(repository.entries("a").length, 1);
});

test("the ledger is append-only", () => {
  const repository = new LedgerRepository();
  assert.throws(() => repository.update());
  assert.throws(() => repository.delete());
});

test("refunds reduce the balance", () => {
  const repository = new LedgerRepository();
  repository.append({
    tenantId: "a",
    accountId: "1",
    amountMinor: 500,
    currency: "USD",
    kind: "charge",
    idempotencyKey: "charge-1",
  });
  repository.append({
    tenantId: "a",
    accountId: "1",
    amountMinor: 200,
    currency: "USD",
    kind: "refund",
    idempotencyKey: "refund-1",
  });

  assert.equal(repository.balance("a", "1"), 300);
});
