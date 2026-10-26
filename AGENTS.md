# AGENTS.md

## What this repository is

Normative project memory for coding agents: append-only decisions, compiled context packs, enforced staleness.
Behavior lives in `src/`; the contract lives in `schema/`; proof lives in `test/`.

## Before editing

1. `npm run build`
2. `node dist/src/cli.js context --for <paths you will touch>`

Use only that output for context. Do not load other records, superseded or retired ones.
After `steadfast new`, fill the record you just created.

## Before committing

1. `npm test`
2. `node dist/src/cli.js check --strict`

## Rules

- Records are append-only. Never edit an active decision; append and supersede. Drafts you just created may be filled.
- `superseded` is derived from `supersedes` and is never written.
- Runtime dependencies: only `yaml`.
- Human-facing prose: only `README.md`. Everything else is agent-facing data.
- New behavior needs a test; a new constraint needs a decision with `enforced_by`.
