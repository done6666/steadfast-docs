# Ledgerline Architecture

Last updated: 2026-09-18

## Purpose

Ledgerline is the billing and ledger service for the platform. It records charges,
refunds and adjustments for every tenant, exposes a small HTTP API, and emits
domain events for downstream consumers such as invoicing, tax and analytics.

This document describes the shape of the system as it is deployed today. It is
the entry point for new engineers and for anyone changing a package boundary.
It intentionally repeats some material from the ADRs so that a reader does not
have to jump between documents to understand the system.

## Repository layout

The repository is organised as a small monorepo:

- `packages/tenancy` contains tenant identity helpers and access checks.
- `packages/ledger` contains money helpers, the append-only repository and the
  outbox implementation.
- `packages/http` contains the shared outbound HTTP client.
- `packages/api` contains the request handlers exposed to the platform.
- `packages/reports` contains read models used by reporting endpoints.
- `packages/worker` contains background jobs.

Each package owns its own tests under `test/`. Tests are written with the Node
test runner and do not require a database, a broker or a network connection.
The in-memory repository is intentionally small; production deployments use the
managed database described below.

## Runtime topology

In production each tenant is deployed with its own database. A tenant maps to a
database, a connection pool and a migration stream. This gives us the strongest
possible isolation: a query written for one tenant physically cannot read the
rows of another tenant. The API tier looks up the tenant from the request
context, selects the matching pool and executes the query against that pool.

The tenancy package is responsible for the lookup. It receives the tenant
identifier from the edge proxy, validates it, and returns a connection handle.
Handlers are not allowed to construct a pool directly. This rule exists because
early versions of the service opened a pool per request and exhausted the
database connection limit during a traffic spike in March.

The deployment pipeline creates one database per tenant during onboarding. The
onboarding job runs the migration suite, seeds the chart of accounts and writes
the tenant record. Offboarding is a two-step process: the tenant is marked
read-only, then the database is exported and dropped after the retention window.

## Data flow

A charge request follows this path:

1. The edge proxy authenticates the caller and resolves the tenant.
2. The API validates the request body and checks the idempotency key.
3. The handler writes an entry to the ledger.
4. The handler publishes an event to the broker.
5. Downstream consumers update invoicing, tax and analytics.

The write and the publish are separate operations. If the broker is unavailable
the request fails and the client retries with the same idempotency key. The
ledger append is idempotent, so the retry does not create a second entry.

Refunds follow the same path with a negative amount and a different event type.
Adjustments are internal operations and do not emit customer-facing events.

## Consistency and failure modes

The ledger is the source of truth. Read models are derived and may lag. The API
never reads a read model for a write decision. The worker may rebuild a read
model from the ledger, but it must never mutate the ledger.

If a read model is corrupted, the recovery procedure is to drop it and rebuild
from the ledger. If the ledger is corrupted, the recovery procedure is a restore
from the most recent backup followed by replay of the write-ahead log. The
runbook covers the exact commands.

The service is designed for at-least-once delivery. Every consumer must be
idempotent. The event envelope carries an event id and a tenant id; consumers
deduplicate on the pair.

## Scaling

The API tier is stateless. It scales horizontally behind the load balancer. The
worker tier is partitioned by tenant. A tenant with a large backlog can be moved
to a dedicated worker without changing the code.

Database scaling is per tenant. A noisy tenant cannot degrade the latency of
another tenant because the pools are separate. The trade-off is operational
complexity: migrations run per tenant and a schema change must be applied to
every database before the API can rely on it.

## Security

Tenant identifiers are never accepted from the request body for authorisation.
They are resolved from the authenticated principal and compared with the
resource owner. Admin endpoints are restricted to the platform operations role.
The admin role can read across tenants for support purposes; the audit log
records every admin request.

Secrets are injected by the platform. The service does not read secrets from the
repository. Local development uses the in-memory repository and a stub provider.

## Observability

Every request emits a structured log line with the tenant, route, status and
latency. The ledger writes an audit event for every append. The worker emits a
metric for pending events and failed deliveries.

Alerts fire when the pending event count grows for more than ten minutes, when
the failed delivery rate exceeds one percent, or when the database pool is
saturated. The on-call rotation and escalation policy live in the runbook.

## Change log

- 2026-09: moved from a shared database to per-tenant databases.
- 2026-08: added the read model for tenant summaries.
- 2026-07: introduced the outbox table for event delivery.
- 2026-06: added the provider port and the stub provider.
- 2026-05: split the monorepo into packages.

## Open questions

- Should the admin role use a separate read-only replica?
- Can we move the outbox to a dedicated store without a second transaction?
- How do we rotate provider credentials without a deploy?

These questions are tracked in the platform backlog. They are not decisions and
should not be treated as constraints by implementers.
