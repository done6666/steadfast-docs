# ADR-0004: Idempotency keys on money-moving requests

- Status: accepted
- Date: 2026-06-02
- Owners: billing, platform

## Context

Clients retry on a timeout. A retry after a committed ledger write must not
create a second charge. The provider also retries; its retry must not create a
second ledger entry. The system needs one key that both sides can use.

## Decision

Every charge and refund carries an `idempotencyKey`. The key is unique per
tenant. The ledger repository deduplicates on `(tenantId, idempotencyKey)` and
returns the existing entry. The outbox event id is derived from the key so the
event is deduplicated as well.

A request without a key is rejected. A key is never reused for a different
amount; the repository returns the original entry, which is the correct
behaviour for a retry and a defect for a new request.

## Consequences

- A retry is safe at the ledger and at the event layer.
- The client owns key generation and must keep the key stable across retries.
- A key collision with a different payload is resolved in favour of the first
  write; the caller must use a new key for a new intent.

## Alternatives considered

- Server-generated request ids: rejected because a client retry creates a new
  id.
- Deduplicate on the payload hash: rejected because two legitimate identical
  charges would collapse.

## Enforcement

`test/charges.test.js` checks the duplicate-key behaviour. The repository
rejects a missing key.
