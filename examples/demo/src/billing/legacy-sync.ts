import { request } from "../api/client.js";

const BATCH_SIZE = 100;

export async function syncLedger(rows: unknown[]): Promise<void> {
  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    const batch = rows.slice(index, index + BATCH_SIZE);
    await request({
      url: "https://ledger.internal/rows",
      method: "POST",
      body: { rows: batch },
    });
  }
}
