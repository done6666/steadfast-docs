# ADR-0006: Events go through the outbox

- Status: accepted
- Date: 2026-06-16
- Owners: platform, invoicing

## Context

The handler wrote the ledger entry and then published to the broker. When the
broker was unavailable the handler returned an error after the ledger commit.
The client retried, the ledger deduplicated, but the event was lost. Downstream
consumers never learned about the charge. The incident took two days to
reconcile.

The dual-write problem is structural: two systems cannot be updated atomically
without a shared transaction or a durable log.

## Decision

The handler writes the ledger entry and an outbox event in the same repository
operation. A worker drains pending outbox events, delivers them to the provider
or the broker, and marks them published. Delivery is at-least-once; the event id
is the deduplication key.

The handler does not publish to the broker directly. It does not call the
provider directly. A failed delivery stays pending and is retried by the worker.

## Consequences

- The event is durable once the ledger entry is committed.
- Delivery is asynchronous; consumers must tolerate a small delay.
- The worker must be idempotent and must not scan the ledger to find work.
- The outbox table grows; a retention job removes published events after seven
  days.

## Alternatives considered

- Direct publish from the handler: rejected after the lost-event incident.
- A database trigger that publishes: rejected because the trigger cannot make an
  external call safely.
- Change data capture: deferred; the outbox is simpler for the current volume.

## Enforcement

`test/outbox.test.js` checks deduplication and the pending state.
`test/charges.test.js` checks that a charge emits an outbox event and does not
call the provider.
