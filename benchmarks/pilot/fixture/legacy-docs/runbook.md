# Runbook

Last updated: 2026-09-01

## Deploy

1. Merge to `main`.
2. The pipeline builds the packages and runs the tests.
3. The pipeline deploys the API canary to one tenant.
4. Watch the error rate and the p99 latency for ten minutes.
5. Promote to all tenants in batches of ten percent.

The worker deploys after the API. A worker deploy does not require a canary
because the worker is idempotent and the queue absorbs the restart.

## Rollback

If the canary fails, roll back the API to the previous image. The database
migration is backward compatible for one release, so the rollback does not
require a schema change. If the migration is not backward compatible, follow the
special rollback procedure in the migration guide.

If the worker fails, stop the worker, roll back the image and restart. Pending
events remain in the queue and are delivered after the restart.

## Incidents

### Broker unavailable

Symptom: charge requests return 503, the broker metric is red.

Action: check the broker status page, fail over to the secondary cluster if the
primary is down, and notify support. Do not bypass the broker; the ledger and
the event stream must stay consistent.

### Provider outage

Symptom: the failed delivery rate is above one percent, the DLQ grows.

Action: switch the provider feature flag to the backup provider, replay the DLQ
after the provider recovers. The backup provider has a lower rate limit.

### Database pool exhausted

Symptom: p99 latency spikes, the pool saturation metric is red.

Action: find the tenant with the highest connection count, throttle it at the
edge, and restart the affected API pods one at a time. Do not restart all pods
at once; the cold start creates a new connection storm.

### Ledger corruption

Symptom: the reconciliation report shows a difference above tolerance.

Action: stop writes, snapshot the ledger, run the reconciliation report for the
affected accounts, and escalate to the finance owner. Do not delete ledger rows.
A correction is a new adjustment entry.

## On-call

The on-call rotation is weekly. The primary handles pages; the secondary handles
customer escalations. The escalation policy is in the platform handbook.

## Maintenance

The read model rebuild runs monthly. The provider credential rotation runs
quarterly. The disaster recovery drill runs twice a year.

## Contacts

- Platform on-call: `#platform-oncall`
- Finance owner: `#finance-ops`
- Security: `#security`
