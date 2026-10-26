import { requireTenant } from "../tenancy/index.js";

export class Outbox {
  #events = [];

  append({ tenantId, type, payload, id }) {
    requireTenant(tenantId);
    if (typeof type !== "string" || type.length === 0) {
      throw new Error("event type is required");
    }

    const eventId = id ?? `evt_${this.#events.length + 1}`;
    const existing = this.#events.find((event) => event.id === eventId);
    if (existing !== undefined) return existing;

    const event = {
      id: eventId,
      tenantId,
      type,
      payload,
      status: "pending",
      attempts: 0,
    };
    this.#events.push(event);
    return event;
  }

  pending(tenantId) {
    requireTenant(tenantId);
    return this.#events.filter(
      (event) => event.tenantId === tenantId && event.status === "pending",
    );
  }

  all(tenantId) {
    requireTenant(tenantId);
    return this.#events.filter((event) => event.tenantId === tenantId);
  }

  markPublished(id) {
    const event = this.#events.find((entry) => entry.id === id);
    if (event === undefined) throw new Error(`unknown event ${id}`);
    event.status = "published";
    return event;
  }

  markFailed(id, reason) {
    const event = this.#events.find((entry) => entry.id === id);
    if (event === undefined) throw new Error(`unknown event ${id}`);
    event.status = "failed";
    event.attempts += 1;
    event.reason = reason;
    return event;
  }
}
