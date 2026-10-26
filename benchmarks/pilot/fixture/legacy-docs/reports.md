# Reports

Last updated: 2026-09-02

## Tenant summary

The tenant summary endpoint returns the tenant's current balance and its most
recent entries. The endpoint is used by the customer dashboard and by support.

The summary is computed from the read model. The read model is updated by the
worker after each ledger append. It is eventually consistent; the dashboard
shows the last committed projection, not the raw ledger.

## Admin reporting

The admin reporting endpoints are used by support and finance. They accept a
list of tenant identifiers and return an aggregate. The aggregate joins the
tenant databases and the ledger tables. The query is bounded by the number of
tenants and runs in the reporting replica.

The admin role is the only role that can call these endpoints. Every request is
audited. The aggregate must not be exposed to a tenant; it is an internal tool.

## Finance close

At month end, finance runs a set of SQL queries against the reporting replica.
The queries join the ledger entries with the invoice lines and group by tenant
and currency. The results are exported to the finance warehouse.

The queries are maintained by the finance team. The platform team reviews them
when the ledger schema changes.

## Read model rebuild

The read model can be rebuilt from the ledger. The rebuild job drops the
projection, scans the ledger in sequence order and writes the projection in
batches. The job is idempotent and can be resumed from the last processed
sequence.

During a rebuild the summary endpoint may return stale data. The dashboard shows
a banner. The rebuild is scheduled outside business hours.

## Metrics

The reporting job emits a metric for the number of tenants, the number of rows
and the duration. A slow query pages the on-call engineer. The query plan is
reviewed quarterly.

## History

- 2026-09: admin reporting moved to a cross-tenant join on the reporting
  replica.
- 2026-08: added the read model rebuild job.
- 2026-07: added the finance close queries.
