import { minorUnits } from "../ledger/money.js";
import { requireTenant } from "../tenancy/index.js";

export async function charge({
  tenantId,
  accountId,
  amountMinor,
  currency = "USD",
  idempotencyKey,
  repository,
  outbox,
}) {
  requireTenant(tenantId);
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    throw new Error("idempotencyKey is required");
  }

  const amount = minorUnits(amountMinor);
  const entry = repository.append({
    tenantId,
    accountId,
    amountMinor: amount,
    currency,
    kind: "charge",
    idempotencyKey,
  });

  const event = outbox.append({
    tenantId,
    id: `evt_${idempotencyKey}`,
    type: "charge.created",
    payload: { entrySeq: entry.seq, accountId, amountMinor: amount, currency },
  });

  return { entry, event };
}
