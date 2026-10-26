# steadfast-docs

**Normative project memory for AI coding agents.** Append-only decisions, compiled context packs, and staleness that fails the build.

Documentation that only agents read. Humans ask; agents remember; CI enforces.

## The problem

Two failure modes kill agent-written documentation:

1. **It rots.** A decision changes in conversation but not in the file. Copies multiply, and the agent follows the wrong one.
2. **It floods the context.** A project with 40 ADRs is roughly 50K tokens. Accuracy drops as input grows, so the agent pays more and reasons worse.

Writing more documentation makes both worse.

## The idea

Do not store what code can prove. Store only what a future agent cannot rediscover: the rule, the reason, and the alternatives already rejected.

- **Invariants** — 10–25 laws, always loaded.
- **Decisions** — append-only YAML records. Never edited, only superseded.
- **Guards** — `deny / instead / check`, carried by decisions. This is what stops drift.
- **Context pack** — compiled per task, hard token cap, only matching records.

No compiled state is committed. The pack is generated on demand, so there is no second copy to go stale.

## Quick start

```bash
npx steadfast-docs init
```

This creates `.steadfast/` and appends a short contract to `AGENTS.md`. Then:

```bash
# the memory that applies to a task (the only thing an agent should read)
npx steadfast-docs context --for src/billing/charge.ts

# append a rule
npx steadfast-docs new --scope billing --topic http-client \
  --decision "All outbound HTTP goes through src/api/client.ts." \
  --applies-to "src/billing/**" \
  --status active \
  --enforced-by test/api/client.contract.test.ts

# before committing
npx steadfast-docs check --strict
```

## Why it does not rot

- **Append-only.** Change a rule by appending a record with `supersedes: [ADR-0012]`. `superseded` is derived, never written. Two active records cannot share a `(scope, topic)`. `check --diff main` compares against the merge base and rejects edits, deletions and renames of records.
- **Content fingerprints.** `verified_by` is a hash of the files matched by `applies_to`, not a commit sha. Verify before committing; rebases cannot invalidate it.
- **Executable claims.** `enforced_by` is a test path or a `!command`. Rules without one are advisory and expire. `check` never executes code; `verify --trust` runs record commands explicitly.
- **Hard budgets.** Per record, per pack, per invariant list, enforced against a conservative token estimate. A pack that cannot fit fails closed instead of silently overflowing.
- **Negative memory.** Rejected proposals are first-class records, so the agent does not re-litigate dead ends.
- **Decision debt.** `check --diff main` flags dependency and build changes that arrived without a decision.

## What it is not

- Not a memory bank or a RAG store. Those recall what happened; this enforces what must hold.
- Not human documentation. In a steadfast project, humans talk to the agent and read code; the memory is machine-first.
- Not a documentation generator. If a fact can be derived from code, derive it; do not store it.

## Example

`examples/demo` is a five-decision project. Its full memory is 551 semantic tokens; the pack for `src/billing/charge.ts` is 375 tokens, including invariants, guards, rejected alternatives, tests and verification commands.

```bash
cd examples/demo
node ../../dist/src/cli.js context --for src/billing/charge.ts
```

## Development

Requires Node 20.11+.

```bash
npm install
npm run build
npm test
node dist/src/cli.js check --strict
```

`verify` runs record-supplied `!commands` only with `--trust`. A CI sequence is: run the test suite, then `steadfast verify --assume <ids>` (add `--trust` only for `!command` records), then `steadfast check --strict`.

## Status

0.1.0. The vertical slice is complete: `init`, `new`, `context`, `check`, `verify`.
Next: editor adapters, a benchmark harness, and a GitHub Action.

## License

MIT
