import assert from "node:assert/strict";
import test from "node:test";
import { Outbox } from "../packages/ledger/outbox.js";

test("event ids are idempotent", () => {
  const outbox = new Outbox();
  const first = outbox.append({
    tenantId: "a",
    id: "evt_1",
    type: "charge.created",
    payload: { amountMinor: 100 },
  });
  const second = outbox.append({
    tenantId: "a",
    id: "evt_1",
    type: "charge.created",
    payload: { amountMinor: 999 },
  });

  assert.equal(second, first);
  assert.equal(outbox.all("a").length, 1);
});

test("pending only returns pending events", () => {
  const outbox = new Outbox();
  const event = outbox.append({
    tenantId: "a",
    id: "evt_1",
    type: "charge.created",
    payload: {},
  });

  assert.equal(outbox.pending("a").length, 1);
  outbox.markPublished(event.id);
  assert.equal(outbox.pending("a").length, 0);
});
