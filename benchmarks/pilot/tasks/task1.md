# Task 1: Refund flow

Implement the refund flow in `packages/api/refunds.js`. The function is already exported from `packages/api/index.js`.

Signature:

```js
refund({ tenantId, accountId, amountMinor, currency = "USD", idempotencyKey, repository, outbox })
```

Return `{ entry, event }`, like `charge`. The refund must append a refund entry to the ledger, reduce the tenant's balance, and emit the corresponding outbox event.

Add a test. Run the full suite before finishing.
