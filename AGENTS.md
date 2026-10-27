# AGENTS.md

## What this repository is

Normative project memory for coding agents: append-only decisions, compiled context packs, enforced staleness.
Behavior lives in `src/`; the contract lives in `schema/`; proof lives in `test/`.
The agent loop lives in `skills/steadfast/SKILL.md` and is installed with `node dist/src/cli.js skill install`.

## Before editing

1. `npm run build`
2. `node dist/src/cli.js context --for <paths you will touch>`

Use only that output for context. If the pack is incomplete, narrow the paths or ask the human before raising the budget; do not pass `--allow-partial`. Do not load other records, superseded or retired ones.
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

<!-- steadfast:begin -->
## Project memory

If the steadfast MCP server is connected, call `steadfast_context` (OpenCode) or `mcp__steadfast__context` (Claude) with the paths you will touch; otherwise run `npx steadfast-docs context --for <paths>`. Use only that output for context.
If context fails, narrow the paths or ask the human before raising the budget; do not pass `--allow-partial`.
Records are not reading material: do not load other records, legacy docs or architecture notes. The pack is the only context.
At session start, run `npx steadfast-docs brief` to recover the current roadmap step. Update `.steadfast/roadmap.yaml` when a step starts or finishes.
If you discover a fact code cannot prove yet, record a finding; retire it when a test proves it.
After a new record, fill the record you just created. Never edit an active record; supersede it.

Before committing, call the steadfast `check` tool, or run `npx steadfast-docs check`.
Optional: install the agent wiring with `npx steadfast-docs mcp install`, `npx steadfast-docs hook install`, and `npx steadfast-docs skill install --platform opencode`.
<!-- steadfast:end -->
