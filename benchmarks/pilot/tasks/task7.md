# Task 7: Refund with a charge reference

Implement the refund flow in `packages/api/refunds.js`. The function is already exported from `packages/api/index.js`.

Signature:

```js
refund({ tenantId, chargeIdempotencyKey, amountMinor, currency = "USD", idempotencyKey, repository, outbox })
```

Return `{ entry, event }`, like `charge`. The refund must append a refund entry to the ledger and emit the corresponding outbox event.

Add a test. Run the full suite before finishing.
