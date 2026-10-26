# Tenancy

Last updated: 2026-09-10

## Model

A tenant is a customer organisation. Every tenant has an identifier, a display
name, a default currency and a database. The identifier is a lower-case slug
chosen at onboarding; it is never reused.

Each tenant owns one database. The database contains the tenant's ledger,
read models and outbox. The API resolves the tenant from the authenticated
principal and selects the database before running a query. The tenant package
is the only place that knows how the selection works.

This model was chosen after a security review in 2025. The review concluded
that physical separation was the cheapest way to guarantee that a missing
`WHERE tenant_id = ?` clause could not leak data. The review accepted the
operational cost of running migrations per tenant.

## Onboarding

The onboarding job performs the following steps:

1. Validate the tenant slug and the billing profile.
2. Create the database and the connection pool.
3. Run the migration suite.
4. Seed the chart of accounts.
5. Write the tenant record and invalidate the tenant cache.

If a step fails the job compensates by dropping the database and the tenant
record. The job is idempotent; it can be retried from the beginning.

## Offboarding

Offboarding marks the tenant read-only, waits for the retention window, exports
the database to object storage, and drops the database. The export is encrypted
with the platform key. The tenant record is kept for audit purposes.

## Access control

Handlers receive a tenant context from the edge proxy. The context contains the
tenant identifier and the principal. Handlers must not accept a tenant
identifier from the request body. The admin role is the only role that can read
across tenants; every admin request is audited.

The tenant cache stores the tenant record for five minutes. A cache miss falls
back to the control-plane database. A cache stampede is prevented by a
single-flight lock.

## Migrations

Migrations are versioned SQL files. The migration runner applies them to one
tenant database at a time. A schema change must be backward compatible for at
least one release so that the API and the worker can be deployed independently.

The migration runner records the applied version in the tenant database. A
failed migration stops the rollout for that tenant and pages the on-call
engineer. The runbook describes the repair procedure.

## Local development

Local development uses the in-memory repository. The tenant package still
validates the identifier and still refuses cross-tenant access, so the local
behaviour matches production closely enough for tests.

## Reporting

The admin reporting job queries all tenant databases and merges the results in
memory. The merge is bounded by the number of tenants and runs during the night.
The job is not exposed through the API.

## Open questions

- Should we move the tenant cache to the control plane?
- Can we run migrations in parallel across tenants?
- Do we need a per-tenant encryption key?
