# ADR-0001: Integer minor units for money

- Status: accepted
- Date: 2026-05-14
- Owners: billing, platform

## Context

Ledgerline stores charges, refunds and adjustments for multiple currencies. An
earlier prototype stored amounts as decimal numbers and used the database
decimal type for sums. The prototype produced rounding differences between the
API, the invoice PDF and the finance warehouse. The differences were small but
they were not reproducible across services because each service used a different
rounding library.

The product contract requires the ledger and the invoice to agree to the cent.
The finance team requires the warehouse sum to agree with the ledger. The model
must be portable across databases and must not depend on a database-specific
decimal implementation.

## Decision

Store money as an integer number of minor units. USD 12.34 is stored as 1234.
The currency is stored next to the amount. Arithmetic is integer arithmetic.
Formatting happens at the edge, using the currency and the locale.

The API accepts `amountMinor` as an integer. It rejects a fractional value with
a validation error. It rejects a negative value; a refund is a separate entry
kind with a positive amount.

## Consequences

- Sums are exact and portable.
- The API contract is explicit about the unit.
- Reporting must divide by 100 for display, which is a presentation concern.
- A future currency with a different exponent needs a currency table; the
  current currencies all use two minor digits.

## Alternatives considered

- Decimal columns: rejected because the rounding policy varied by service.
- Floating point: rejected because binary fractions cannot represent cents
  exactly.
- A money library with a decimal type: rejected because the serialization
  boundary would still need a canonical unit.

## Enforcement

`test/money.test.js` covers integer validation, addition and formatting. The
ledger repository rejects a non-integer amount.
