import assert from "node:assert/strict";
import test from "node:test";
import { charge } from "../../packages/api/charges.js";
import { refund } from "../../packages/api/index.js";
import { Outbox } from "../../packages/ledger/outbox.js";
import { LedgerRepository } from "../../packages/ledger/repository.js";

async function setup() {
  const repository = new LedgerRepository();
  const outbox = new Outbox();
  await charge({
    tenantId: "a",
    accountId: "1",
    amountMinor: 1000,
    idempotencyKey: "charge-1",
    repository,
    outbox,
  });
  return { repository, outbox };
}

test("a refund under the remaining charge is accepted", async () => {
  const { repository, outbox } = await setup();
  const result = await refund({
    tenantId: "a",
    chargeIdempotencyKey: "charge-1",
    amountMinor: 600,
    idempotencyKey: "refund-1",
    repository,
    outbox,
  });

  assert.equal(result.entry.kind, "refund");
  assert.equal(result.entry.amountMinor, 600);
  assert.equal(result.entry.chargeIdempotencyKey, "charge-1");
  assert.equal(repository.balance("a", "1"), 400);
  assert.equal(
    outbox.all("a").filter((event) => event.type === "refund.created").length,
    1,
  );
});

test("a refund above the remaining charge is rejected per charge", async () => {
  const { repository, outbox } = await setup();

  await refund({
    tenantId: "a",
    chargeIdempotencyKey: "charge-1",
    amountMinor: 600,
    idempotencyKey: "refund-1",
    repository,
    outbox,
  });

  await charge({
    tenantId: "a",
    accountId: "1",
    amountMinor: 1000,
    idempotencyKey: "charge-2",
    repository,
    outbox,
  });

  await assert.rejects(
    () =>
      refund({
        tenantId: "a",
        chargeIdempotencyKey: "charge-1",
        amountMinor: 500,
        idempotencyKey: "refund-2",
        repository,
        outbox,
      }),
    /exceed|remaining|charge/i,
  );

  assert.equal(repository.balance("a", "1"), 1400);
});

test("an unknown charge is rejected", async () => {
  const { repository, outbox } = await setup();

  await assert.rejects(
    () =>
      refund({
        tenantId: "a",
        chargeIdempotencyKey: "missing",
        amountMinor: 100,
        idempotencyKey: "refund-1",
        repository,
        outbox,
      }),
    /charge|unknown|not found/i,
  );
});

test("a cross-tenant charge is rejected", async () => {
  const repository = new LedgerRepository();
  const outbox = new Outbox();

  await charge({
    tenantId: "b",
    accountId: "1",
    amountMinor: 1000,
    idempotencyKey: "charge-b",
    repository,
    outbox,
  });

  await assert.rejects(
    () =>
      refund({
        tenantId: "a",
        chargeIdempotencyKey: "charge-b",
        amountMinor: 100,
        idempotencyKey: "refund-1",
        repository,
        outbox,
      }),
    /charge|tenant|not found/i,
  );
});

test("a duplicate refund key is idempotent", async () => {
  const { repository, outbox } = await setup();
  const input = {
    tenantId: "a",
    chargeIdempotencyKey: "charge-1",
    amountMinor: 600,
    idempotencyKey: "refund-1",
    repository,
    outbox,
  };

  const first = await refund(input);
  const second = await refund({ ...input, amountMinor: 700 });

  assert.equal(second.entry.seq, first.entry.seq);
  assert.equal(repository.entries("a").length, 2);
  assert.equal(
    outbox.all("a").filter((event) => event.type === "refund.created").length,
    1,
  );
});
