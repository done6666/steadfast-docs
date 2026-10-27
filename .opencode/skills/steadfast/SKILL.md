---
name: steadfast
description: Use when a repository has .steadfast/ or AGENTS.md mentions steadfast. Enforces a context-first loop, append-only decisions, guards and verification before commit.
---

# Steadfast Memory

## Trigger

Use this skill when `.steadfast/` exists or `AGENTS.md` mentions steadfast.

With MCP connected, call its `brief`, `context`, `check`, `verify`, `new`,
`finding` and `supersede` tools instead of the CLI below; clients prefix the
names (`steadfast_*` in OpenCode, `mcp__steadfast__*` in Claude).

## 0. Recover state

Run `npx steadfast-docs brief` first. It prints the current roadmap step, next
steps, blockers, recent commits and worktrees. Do not open
`.steadfast/roadmap.yaml` directly; edit it only to update status and evidence.

## 1. Plan the path set

List the files or directories you will touch.

## 2. Load only the pack

Run:

    npx steadfast-docs context --for <path[,path]>

Files, directories and globs are accepted. Read the output. Do not open
`.steadfast/decisions/`, superseded or retired records, other docs, ADRs or
READMEs. They are the drift this replaces.

`context` refuses a pack with `omitted` above zero; narrow the paths and
re-run. Never pass `--allow-partial` or edit on a partial pack. If it fails,
stop and report the needed budget; do not raise it yourself. An uncovered
selector warns: proceed with invariants and record a decision. A selector
matching no files is a bad path; fix it. If legacy docs remain, ask for
`steadfast retire <path> --apply`.

## 3. Restate the constraints

Before the first edit, write at most three lines:

- the invariants that apply
- the guards (`deny` / `instead`) that apply
- the checks you will run

If a guard blocks the obvious solution, follow `instead`. If `instead` is
impossible, stop and propose a superseding decision. Never route around a guard.

## 4. Edit

Keep changes inside the path set; if a file outside it is needed, stop and
expand the plan.

Never edit a decision that is already in force. A draft you created in this
task may be filled until it becomes active.

## 5. Verify

`check` validates the memory; it does **not** execute tests.

Run the checks the records name, then:

    npx steadfast-docs check --strict

For each pack id, run `npx steadfast-docs verify <id> --assume`; `--assume`
asserts the check passed. If one command covers several, pass ids explicitly:

    npx steadfast-docs verify <id...> --run "<command>"

Use `--trust` only after reading a record's `!command`.

`check` must be green before commit; never hand-edit `verified_by`.

## 6. Record

At the end, ask: did I make a choice a future agent could not rediscover from
the code?

If yes, create the record:

    npx steadfast-docs new --scope <scope> --topic <topic> \
      --decision "<one sentence>" \
      --why "<one line>" \
      --applies-to "<glob>" \
      --status draft

Fill `why`, `guards` and `rejected` in that draft. It is not in force yet.
Then set `status: active` and run `verify`.

- One rule per record; put rejected alternatives in `rejected`, one line each.
- Prefer a guard (`deny`, `instead`, `check`) over prose.
- If a rule changes, run `steadfast supersede <id> --decision "<rule>"`.
- If you learn a fact code cannot prove yet, record it with `steadfast finding new`; retire it when a test proves it.
- Unenforceable rules are advisory and expire.
- When a roadmap step is finished, set `status: done` and `evidence: <test or
  commit>` in `.steadfast/roadmap.yaml`, then make the next unblocked step
  `current`.

## 7. Hand off

Tell the human only:

- what changed
- decisions that need approval, one line each
- any guard that blocked a path

Leave a durable handoff in the commit body or an issue: `Finding:`, `Decision:`,
`Next:`. Update README `Status` on release changes.

## Stop conditions

Stop and ask, do not improvise, when:

- `check` fails twice for different reasons
- the pack is partial or over budget
- a guard conflict has no `instead`
- a needed rule is missing from the pack
- a record would need to be edited in place
