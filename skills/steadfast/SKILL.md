---
name: steadfast
description: Use when a repository has .steadfast/ or AGENTS.md mentions steadfast. Enforces a context-first loop, append-only decisions, guards and verification before commit.
---

# Steadfast Memory

## Trigger

Use this skill when `.steadfast/` exists or `AGENTS.md` mentions steadfast.
It does not replace the task; it constrains how you read, change and record.

With MCP connected, call its `context`, `check`, `verify`, `new` and `supersede`
tools instead of the CLI below; clients prefix the names (`steadfast_*` in
OpenCode, `mcp__steadfast__*` in Claude).

## 1. Plan the path set

Before editing, list every file or directory the task will touch.
If you cannot yet, start with three paths and expand as you learn.

## 2. Load only the pack

Run:

    npx steadfast-docs context --for <path[,path]>

Read the output. Do not open `.steadfast/decisions/`, superseded or retired
records. Do not read other documentation, ADRs, architecture notes or READMEs.
They are the drift this replaces; the pack is complete only when its header
says `omitted: 0`.

When the path set grows, run the command again with the full set.
If the header shows `omitted` above zero, the pack is incomplete: narrow the
path set and re-run, or stop and report. Never edit on a partial pack.
If the pack reports `over-budget`, stop; never guess missing rules.
If legacy documentation still exists in the working tree, stop and ask the
human to retire it with `steadfast retire <path> --apply`.

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

For every decision id in the pack:

    npx steadfast-docs verify <id> --assume

`--assume` is an assertion that the check passed. Never use it without running
the check. If one command covers several records, pass their ids explicitly:

    npx steadfast-docs verify <id...> --run "<command>"

Use `--trust` only after reading a record's `!command`; it executes code.

`check` must be green before you report or commit. Never edit `verified_by`
by hand to silence it.

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

- One rule per record. No history, background or alternatives essay.
- Put rejected alternatives in `rejected`, one line each.
- Prefer a guard (`deny`, `instead`, `check`) over prose.
- If a rule changes, run `steadfast supersede <id> --decision "<rule>"`.
- If the choice is not enforceable, leave it advisory; it will expire.

## 7. Hand off

Tell the human only:

- what changed
- decisions that need approval, one line each
- any guard that blocked a path

Do not summarize the documentation. Do not ask the human to read a record.

## Optional critic

If subagents exist, give a fresh agent only the decision diff; ask it to cut
contradictions, restated code and unverifiable claims.

## Stop conditions

Stop and ask, do not improvise, when:

- `check` fails twice for different reasons
- the pack is partial or over budget
- a guard conflict has no `instead`
- a needed rule is missing from the pack
- a record would need to be edited in place
