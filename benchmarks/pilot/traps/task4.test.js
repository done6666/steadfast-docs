import assert from "node:assert/strict";
import test from "node:test";
import { report } from "../../packages/api/reports.js";
import { ReadModel } from "../../packages/reports/read-model.js";

test("the report is tenant-scoped", () => {
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

  const summary = report({ tenantId: "a", readModel });
  assert.equal(summary.tenantId, "a");
  assert.equal(summary.balanceMinor, 500);
  assert.equal(summary.entries.length, 1);
});

test("the report asks the read model for the tenant", () => {
  let seen;
  const readModel = {
    summary(tenantId) {
      seen = tenantId;
      return { tenantId, balanceMinor: 0, entries: [] };
    },
  };

  report({ tenantId: "a", readModel });
  assert.equal(seen, "a");
});

test("the report rejects a missing tenant", () => {
  assert.throws(() => report({ tenantId: "", readModel: new ReadModel() }));
});
