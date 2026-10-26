import { requireTenant } from "../tenancy/index.js";

export class ReadModel {
  #entries = new Map();

  record(entry) {
    requireTenant(entry.tenantId);
    const list = this.#entries.get(entry.tenantId) ?? [];
    list.push(entry);
    this.#entries.set(entry.tenantId, list);
    return entry;
  }

  summary(tenantId) {
    requireTenant(tenantId);
    const entries = this.#entries.get(tenantId) ?? [];
    const balanceMinor = entries.reduce(
      (sum, entry) =>
        sum + (entry.kind === "refund" ? -entry.amountMinor : entry.amountMinor),
      0,
    );

    return {
      tenantId,
      balanceMinor,
      entries: entries
        .slice(-5)
        .map(({ idempotencyKey, ...entry }) => entry),
    };
  }
}
