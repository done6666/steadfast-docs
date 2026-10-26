# ADR-0002: Shared schema with an explicit tenant key

- Status: accepted
- Date: 2026-05-21
- Owners: platform, security

## Context

The service needs strong tenant isolation without multiplying the operational
surface. A per-tenant database gives physical isolation but makes migrations,
reporting and onboarding a per-tenant job. A shared schema gives one migration
stream and one connection pool but requires every query to carry the tenant key.

The security review accepted a shared schema if the tenant key is resolved from
the authenticated principal and if the repository API makes an unscoped query
impossible.

## Decision

Use one schema. Every ledger and read-model row carries `tenant_id`. The
repository exposes only tenant-scoped methods: `append`, `entries` and
`balance` all take a tenant identifier. There is no `all()` method and no
unscoped query helper.

The tenant identifier is resolved by the edge proxy and validated by the tenancy
package. A handler never accepts it from the request body for authorisation.

## Consequences

- One migration stream and one pool.
- A missing tenant filter is a code review defect, not a physical impossibility;
  the repository API and the tests are the defence.
- Cross-tenant admin reads must go through an explicit admin path and are
  audited.
- A noisy tenant can affect the shared pool; the edge throttles per tenant.

## Alternatives considered

- Database per tenant: rejected for operational cost. See the rejected record
  for the tenancy-silo proposal.
- Schema per tenant: rejected for migration cost.
- Row-level security: deferred; it would be a second layer, not a replacement
  for the repository API.

## Enforcement

`test/tenancy.test.js` checks that entries are scoped and that a missing tenant
identifier is rejected. The repository has no unscoped read method.
