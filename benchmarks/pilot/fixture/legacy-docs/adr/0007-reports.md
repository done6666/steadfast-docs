# ADR-0007: Reports read tenant-scoped projections

- Status: accepted
- Date: 2026-06-23
- Owners: platform, finance

## Context

The dashboard needs a tenant summary on every page load. Querying the ledger for
every request put read pressure on the write path. The admin reporting tools
need cross-tenant aggregates, but the customer-facing summary must never expose
another tenant's rows.

## Decision

Customer-facing summaries read from a tenant-scoped read model. The read model
is keyed by `tenant_id` and exposes only `summary(tenantId)`. It contains the
balance and the last five entries. It is eventually consistent.

Cross-tenant admin aggregates use a separate admin path. The path is audited and
is not available to tenant principals. The customer summary never joins the
ledger across tenants.

## Consequences

- The dashboard read path is cheap and isolated.
- The summary can lag the ledger by a few seconds.
- A read model rebuild is required after a projection bug.
- The admin path is a separate code path and needs its own tests.

## Alternatives considered

- Query the ledger for every summary: rejected for write-path pressure.
- One global projection: rejected because a missing tenant filter would leak
  data.
- Materialised views per tenant: rejected for migration cost.

## Enforcement

`test/reports.test.js` checks that the summary is tenant-scoped and keeps at
most five entries.
