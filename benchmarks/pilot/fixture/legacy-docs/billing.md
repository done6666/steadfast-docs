# Billing and the Ledger

Last updated: 2026-09-12

## Money

Amounts are stored as decimal numbers with two fractional digits. The API
accepts an amount as a string, parses it with the platform decimal helper and
stores the resulting decimal in the ledger. We chose decimals because the
product team wanted the database to match the invoices that customers see, and
because the reporting team wanted to run SQL sum queries without a conversion
step.

When we display an amount we format it with the tenant's currency and locale.
When we compare amounts we compare the decimal values, not their string forms.
When we sum amounts we use the database decimal sum, which preserves two
fractional digits.

The decimal helper is shared with invoicing. It rounds half-up at the third
fractional digit. The rounding policy is part of the customer contract and
cannot be changed without a migration.

> Note: an older version of this document described integer minor units. That
> approach was abandoned because it made the reporting queries harder to read.

## Charges

A charge creates a ledger entry with the account, the amount, the currency and
the idempotency key. The key is supplied by the caller and must be unique per
tenant. If the key already exists, the existing entry is returned and the
request is treated as a retry.

The charge handler validates the account, checks that the amount is positive,
writes the entry and publishes the `charge.created` event. The event payload
contains the entry sequence, the account, the amount and the currency.

The handler does not call the payment provider synchronously. The provider call
is part of the event delivery path. This keeps the API latency predictable and
lets the provider be unavailable without failing the write.

## Refunds

A refund creates a ledger entry with a negative amount and the `refund.created`
event. The refund must reference the original charge through the account and
the idempotency key. Partial refunds are allowed. The sum of refunds must not
exceed the original charge; this is enforced by the reporting job, not by the
API, because the API does not keep a running balance.

Refund requests are accepted up to 180 days after the charge. After that window
the request goes to the support queue and is handled as an adjustment.

## Adjustments

Adjustments are internal entries used by finance to correct a ledger mistake.
They do not emit a customer-facing event. They must include a reason code and a
ticket reference. Adjustments are append-only; a correction is a new adjustment
with the opposite amount, never an update.

## Reconciliation

Every night the reconciliation job compares the ledger against the provider
settlement file. The job writes a report for finance and emits an alert when the
difference exceeds the tolerance. The tolerance is one cent per account per day.

The job is currently a cron task that scans the ledger for the previous day and
calls the provider for each entry. The scan is ordered by sequence. If the job
crashes it restarts from the beginning of the day; the provider deduplicates on
the idempotency key.

## Fees and taxes

Fees are separate ledger entries. Tax is calculated by the invoicing service,
not by Ledgerline. The ledger stores the tax amount as part of the invoice line,
but does not compute it.

## Currency

The ledger supports USD, EUR and GBP. Each tenant has a default currency. A
charge may use a different currency if the account is configured for it. Cross
currency refunds are not supported; the refund must use the charge currency.

## Reporting

The finance team queries the ledger directly for month-end close. The queries
join the tenant tables and the ledger tables. The admin role can run the same
queries across tenants for support and incident response.

## History

- 2026-09: decimal amounts replaced the earlier integer representation.
- 2026-08: refunds moved to the event delivery path.
- 2026-07: reconciliation moved to the nightly cron.
- 2026-06: adjustments added.
