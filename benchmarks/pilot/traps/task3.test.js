import assert from "node:assert/strict";
import test from "node:test";
import { Outbox } from "../../packages/ledger/outbox.js";
import { reconcile } from "../../packages/worker/outbox-worker.js";

function seedOutbox(count) {
  const outbox = new Outbox();
  for (let index = 0; index < count; index += 1) {
    outbox.append({
      tenantId: "a",
      id: `evt_${index}`,
      type: "charge.created",
      payload: { amountMinor: 100 + index },
    });
  }
  return outbox;
}

test("reconcile drains pending events once", async () => {
  const outbox = seedOutbox(2);
  const delivered = [];
  const provider = {
    name: "stub",
    async charge(payload) {
      delivered.push(payload);
    },
  };

  const first = await reconcile({ tenantId: "a", outbox, provider });
  assert.equal(first, 2);
  assert.equal(delivered.length, 2);

  const second = await reconcile({ tenantId: "a", outbox, provider });
  assert.equal(second, 0);
  assert.equal(delivered.length, 2);
  assert.equal(outbox.pending("a").length, 0);
});

test("reconcile respects the limit", async () => {
  const outbox = seedOutbox(3);
  const provider = { name: "stub", async charge() {} };

  assert.equal(await reconcile({ tenantId: "a", outbox, provider, limit: 2 }), 2);
  assert.equal(outbox.pending("a").length, 1);
  assert.equal(await reconcile({ tenantId: "a", outbox, provider, limit: 2 }), 1);
});

test("reconcile does not read the ledger", async () => {
  const outbox = seedOutbox(1);
  const repository = new Proxy(
    {},
    {
      get() {
        throw new Error("worker read the ledger");
      },
    },
  );
  const provider = { name: "stub", async charge() {} };

  const delivered = await reconcile({
    tenantId: "a",
    outbox,
    provider,
    repository,
  });
  assert.equal(delivered, 1);
});

test("a failed delivery is never marked published", async () => {
  const outbox = seedOutbox(1);
  const provider = {
    name: "stub",
    async charge() {
      throw new Error("provider down");
    },
  };

  try {
    await reconcile({ tenantId: "a", outbox, provider });
  } catch {
    // A thrown error is acceptable; the event must remain uncommitted.
  }

  assert.notEqual(outbox.all("a")[0].status, "published");
});
