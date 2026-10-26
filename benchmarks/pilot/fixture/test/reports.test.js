import assert from "node:assert/strict";
import test from "node:test";
import { ReadModel } from "../packages/reports/read-model.js";

test("the read model is tenant-scoped", () => {
  const readModel = new ReadModel();
  readModel.record({
    tenantId: "a",
    accountId: "1",
    amountMinor: 500,
    currency: "USD",
    kind: "charge",
    idempotencyKey: "k1",
  });
  readModel.record({
    tenantId: "b",
    accountId: "1",
    amountMinor: 900,
    currency: "USD",
    kind: "charge",
    idempotencyKey: "k2",
  });

  const summary = readModel.summary("a");
  assert.equal(summary.tenantId, "a");
  assert.equal(summary.balanceMinor, 500);
  assert.equal(summary.entries.length, 1);
});

test("summaries keep at most five entries", () => {
  const readModel = new ReadModel();
  for (let index = 0; index < 7; index += 1) {
    readModel.record({
      tenantId: "a",
      accountId: "1",
      amountMinor: 100,
      currency: "USD",
      kind: "charge",
      idempotencyKey: `k${index}`,
    });
  }

  assert.equal(readModel.summary("a").entries.length, 5);
});
