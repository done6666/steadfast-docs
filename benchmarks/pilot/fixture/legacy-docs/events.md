# Events

Last updated: 2026-09-05

## Delivery model

The request handler publishes domain events directly to the broker after the
ledger write. The broker is a managed Kafka cluster. The topic is partitioned by
tenant and the event key is the tenant identifier, which guarantees per-tenant
ordering.

The publish is synchronous from the handler's point of view: the handler waits
for the broker acknowledgement before returning. If the broker is unavailable
the handler returns a 503 and the client retries. The idempotency key on the
write side prevents a duplicate ledger entry; the event id prevents a duplicate
consumer effect.

## Event envelope

Every event has the following fields:

- `id`: a globally unique event id.
- `tenantId`: the tenant that owns the event.
- `type`: the event type, such as `charge.created`.
- `payload`: the event-specific body.
- `occurredAt`: an ISO timestamp.
- `version`: the schema version.

Consumers must ignore unknown fields and must tolerate a missing optional field.
A breaking change requires a new event type, not a new field on an old type.

## Topics

- `ledger.charge` carries charge events.
- `ledger.refund` carries refund events.
- `ledger.adjustment` carries internal adjustments.
- `ledger.dlq` carries events that exhausted their retries.

The DLQ is monitored by the on-call engineer. Replaying a DLQ message is a
manual operation; the runbook describes the procedure.

## Consumers

Invoicing consumes charge and refund events and creates invoice lines. Tax
consumes charge events and computes tax. Analytics consumes everything and
writes to the warehouse. Each consumer has its own consumer group and its own
retry policy.

Consumers are at-least-once. A consumer must deduplicate on the event id. A
consumer that writes to a database must use the event id as the idempotency key
of its own write.

## Failure handling

If a consumer fails, it retries three times with backoff and then publishes to
the DLQ. The DLQ message includes the original event and the error. The on-call
engineer decides whether to fix the consumer and replay or to drop the message.

If the broker is unavailable at publish time, the handler returns 503. The
client is expected to retry. The ledger entry is already committed, so the retry
must not create a second entry. This is why the idempotency key is mandatory.

## Outbox

An outbox table was proposed in 2025 to remove the dual-write problem. The
proposal was not adopted because the team considered the broker reliable enough
and the outbox added a second write and a worker. The table remains in the
architecture backlog.

## History

- 2026-09: direct publish reinstated as the standard after the outbox pilot.
- 2026-08: added the DLQ replay procedure.
- 2026-07: added the event envelope version field.
