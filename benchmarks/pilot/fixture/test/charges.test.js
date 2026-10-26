import assert from "node:assert/strict";
import test from "node:test";
import { charge } from "../packages/api/index.js";
import { LedgerRepository } from "../packages/ledger/repository.js";
import { Outbox } from "../packages/ledger/outbox.js";

function setup() {
  return {
    repository: new LedgerRepository(),
    outbox: new Outbox(),
  };
}

test("charge appends and emits an outbox event", async () => {
  const { repository, outbox } = setup();
  const result = await charge({
    tenantId: "a",
    accountId: "1",
    amountMinor: 500,
    idempotencyKey: "k1",
    repository,
    outbox,
  });

  assert.equal(result.entry.seq, 1);
  assert.equal(result.entry.kind, "charge");
  assert.equal(outbox.pending("a").length, 1);
  assert.equal(outbox.all("a")[0].type, "charge.created");
});

test("charge is idempotent", async () => {
  const { repository, outbox } = setup();
  const input = {
    tenantId: "a",
    accountId: "1",
    amountMinor: 500,
    idempotencyKey: "k1",
    repository,
    outbox,
  };

  const first = await charge(input);
  const second = await charge({ ...input, amountMinor: 900 });

  assert.equal(second.entry.seq, first.entry.seq);
  assert.equal(repository.entries("a").length, 1);
  assert.equal(outbox.all("a").length, 1);
});

test("charge rejects invalid amounts and missing keys", async () => {
  const { repository, outbox } = setup();
  const base = {
    tenantId: "a",
    accountId: "1",
    amountMinor: 500,
    idempotencyKey: "k1",
    repository,
    outbox,
  };

  await assert.rejects(() => charge({ ...base, amountMinor: 5.5 }));
  await assert.rejects(() => charge({ ...base, idempotencyKey: "" }));
  await assert.rejects(() => charge({ ...base, tenantId: "" }));
});
