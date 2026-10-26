import { request } from "../api/client.js";

export async function charge(
  customerId: string,
  amountCents: number,
  idempotencyKey: string,
): Promise<void> {
  if (amountCents <= 0) throw new Error("amount must be positive");

  await request({
    url: "https://billing.internal/charges",
    method: "POST",
    body: { customerId, amountCents },
    headers: { "idempotency-key": idempotencyKey },
    timeoutMs: 2_000,
  });
}
