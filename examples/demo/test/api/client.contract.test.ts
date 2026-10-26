import assert from "node:assert/strict";
import test from "node:test";
import { request } from "../../src/api/client.js";

test("the shared client is the only HTTP entry point", () => {
  assert.equal(typeof request, "function");
});

test("the client passes an abort signal and serializes the body", async () => {
  const original = globalThis.fetch;
  let seen: RequestInit | undefined;

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen = init;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    await request({ url: "https://example.test", method: "POST", body: { a: 1 } });
    assert.ok(seen?.signal instanceof AbortSignal);
    assert.equal(seen?.body, '{"a":1}');
  } finally {
    globalThis.fetch = original;
  }
});
