# ADR-0008: A single payment provider

- Status: accepted
- Date: 2026-06-30
- Owners: billing

## Context

Ledgerline started with one payment provider. The provider adapter is selected
by name from a small registry. The registry contains one entry. The team wants
predictable behaviour and a single settlement file to reconcile.

## Decision

The registry contains one production provider. The provider adapter is selected
by name; the name is a configuration value, not a request field. The handler
does not branch on the provider.

## Consequences

- One settlement file and one reconciliation path.
- A provider outage is a full outage; the runbook covers the failover procedure.
- Adding a second provider requires a new decision and a new adapter.

## Alternatives considered

- Two providers from day one: rejected because the reconciliation and the
  feature-flag surface would double before there was a customer need.

## Enforcement

`test/provider.test.js` checks that the stub provider is registered.
