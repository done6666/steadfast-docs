import assert from "node:assert/strict";
import test from "node:test";
import { refund } from "../../packages/api/index.js";
import { Outbox } from "../../packages/ledger/outbox.js";
import { LedgerRepository } from "../../packages/ledger/repository.js";

function setup() {
  return { repository: new LedgerRepository(), outbox: new Outbox() };
}

test("refund appends a refund entry and an outbox event", async () => {
  const { repository, outbox } = setup();
  const result = await refund({
    tenantId: "a",
    accountId: "1",
    amountMinor: 300,
    idempotencyKey: "r1",
    repository,
    outbox,
  });

  assert.equal(result.entry.kind, "refund");
  assert.equal(result.entry.amountMinor, 300);
  assert.equal(result.entry.tenantId, "a");
  assert.equal(repository.balance("a", "1"), -300);
  assert.equal(outbox.pending("a").length, 1);
  assert.equal(outbox.all("a")[0].type, "refund.created");
});

test("refund rejects invalid input", async () => {
  const { repository, outbox } = setup();
  const base = {
    tenantId: "a",
    accountId: "1",
    amountMinor: 300,
    idempotencyKey: "r1",
    repository,
    outbox,
  };

  await assert.rejects(() => refund({ ...base, amountMinor: 3.5 }));
  await assert.rejects(() => refund({ ...base, tenantId: "" }));
  await assert.rejects(() => refund({ ...base, idempotencyKey: "" }));
});

test("refund is idempotent and does not duplicate the event", async () => {
  const { repository, outbox } = setup();
  const input = {
    tenantId: "a",
    accountId: "1",
    amountMinor: 300,
    idempotencyKey: "r1",
    repository,
    outbox,
  };

  const first = await refund(input);
  const second = await refund({ ...input, amountMinor: 900 });

  assert.equal(second.entry.seq, first.entry.seq);
  assert.equal(repository.entries("a").length, 1);
  assert.equal(outbox.all("a").length, 1);
});
