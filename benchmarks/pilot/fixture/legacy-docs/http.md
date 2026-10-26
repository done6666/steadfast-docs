# Outbound HTTP

Last updated: 2026-09-08

## Current guidance

Each service owns its HTTP stack. A service that calls a provider imports axios,
constructs a client in its module scope and configures the timeout that fits its
own latency budget. This keeps the transport concerns close to the code that
knows the provider's behaviour.

The provider adapter sets a ten second timeout and retries idempotent requests
twice with exponential backoff. The invoicing client sets a thirty second
timeout because the invoice PDF generation is slow. The tax client sets a five
second timeout and does not retry. These numbers were tuned in production and
should not be collected into a shared default.

## Why not a shared client?

We tried a shared client in 2025. It hid the timeout in a configuration file and
made it hard for a service owner to change the retry policy without touching
another team's package. The experiment was rolled back after a provider incident
where the shared retry policy amplified an outage.

The platform team still maintains a small HTTP helper for internal services, but
customer-facing provider calls are expected to use their own client. The helper
is not a policy layer; it does not retry, does not set a timeout and does not
normalise errors.

## Retries

Retry only idempotent requests. A charge request is idempotent because it
carries a key; a refund request is idempotent for the same reason. A provider
call that creates a resource without a key must not be retried automatically.

Use exponential backoff with jitter. The first retry waits 200 ms, the second
waits 800 ms, the third waits 3.2 s. After three retries return an error to the
caller and let the worker decide whether to retry later.

Do not retry on 4xx responses except 408 and 429. Do not retry on a TLS error
without a new connection. Do not retry a request whose body has already been
consumed.

## Timeouts

Every request must have a timeout. A request without a timeout can pin a
connection and exhaust the pool. The timeout must be shorter than the caller's
deadline. If the caller has no deadline, the service timeout is the deadline.

The worker uses a two minute deadline for a batch. A single event delivery uses
the provider's timeout. If a batch exceeds the deadline the worker stops and
lets the next run continue.

## Observability

Log the provider, the route, the status and the latency. Do not log the request
body; it contains account identifiers. Do not log the idempotency key; it is a
customer secret. Emit a metric for every retry and every timeout.

## Migration note

The platform team is experimenting with a shared `packages/http` client. The
experiment is not approved for customer-facing traffic. Do not use it in new
provider adapters until the platform team publishes the migration guide.

## History

- 2026-09: reverted to per-service axios clients after the shared client
  experiment.
- 2026-08: added the retry guidance.
- 2026-07: added the timeout guidance.
