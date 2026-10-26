import { request } from "../http/client.js";
import { defineProvider } from "./port.js";

const stub = defineProvider({
  name: "stub",
  async charge({ amountMinor, currency, idempotencyKey, accountId }) {
    const response = await request({
      url: "https://provider.example/charges",
      method: "POST",
      body: { amountMinor, currency, idempotencyKey, accountId },
    });
    return { provider: "stub", ok: response.ok };
  },
});

export const providers = new Map([["stub", stub]]);

export function getProvider(name) {
  const provider = providers.get(name);
  if (provider === undefined) throw new Error(`unknown provider: ${name}`);
  return provider;
}
