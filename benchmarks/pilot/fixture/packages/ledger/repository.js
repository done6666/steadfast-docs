import { requireTenant } from "../tenancy/index.js";
import { minorUnits } from "./money.js";

export class LedgerRepository {
  #entries = [];

  append(entry) {
    requireTenant(entry.tenantId);
    const amountMinor = minorUnits(entry.amountMinor);
    if (typeof entry.idempotencyKey !== "string" || entry.idempotencyKey.length === 0) {
      throw new Error("idempotencyKey is required");
    }

    const existing = this.#entries.find(
      (stored) =>
        stored.tenantId === entry.tenantId &&
        stored.idempotencyKey === entry.idempotencyKey,
    );
    if (existing !== undefined) return existing;

    const stored = Object.freeze({
      ...entry,
      amountMinor,
      seq: this.#entries.length + 1,
    });
    this.#entries.push(stored);
    return stored;
  }

  entries(tenantId) {
    requireTenant(tenantId);
    return this.#entries.filter((entry) => entry.tenantId === tenantId);
  }

  balance(tenantId, accountId) {
    requireTenant(tenantId);
    return this.entries(tenantId)
      .filter((entry) => entry.accountId === accountId)
      .reduce(
        (sum, entry) =>
          sum + (entry.kind === "refund" ? -entry.amountMinor : entry.amountMinor),
        0,
      );
  }

  update() {
    throw new Error("the ledger is append-only");
  }

  delete() {
    throw new Error("the ledger is append-only");
  }
}
