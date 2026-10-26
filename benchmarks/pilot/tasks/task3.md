# Task 3: Outbox worker

Implement the outbox worker in `packages/worker/outbox-worker.js`.

```js
reconcile({ tenantId, outbox, provider, limit = 100 })
```

Drain pending outbox events for the tenant, deliver each event to the provider, mark it published, and return the number delivered. It must be safe to run repeatedly.

Add a test. Run the full suite.
