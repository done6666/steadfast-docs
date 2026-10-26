# ADR-0005: The ledger is append-only

- Status: accepted
- Date: 2026-06-09
- Owners: finance, platform

## Context

The ledger is the source of truth for balances and for the finance close. An
update or a delete destroys the audit trail and makes a reconciliation
difference impossible to explain. The finance team requires every correction to
be traceable to a person and a ticket.

## Decision

Ledger entries are immutable. There is no update and no delete. A correction is
a new entry with the opposite amount and a reason code. The repository throws on
`update` and `delete`. The stored entry is frozen at append time.

## Consequences

- The audit trail is complete.
- A mistake costs a second entry, not an edit.
- Storage grows monotonically; the retention job archives old partitions.
- Read models must be rebuilt from entries, not patched in place.

## Alternatives considered

- Soft delete: rejected because a deleted entry still changes the balance
  semantics and the audit trail becomes conditional.
- Mutable rows with an audit table: rejected because the ledger and the audit
  table can disagree.

## Enforcement

`test/ledger.test.js` checks that `update` and `delete` throw and that a refund
reduces the balance through a new entry.
