# Pilot: ledgerline

A synthetic multi-tenant billing ledger used to test steadfast against a realistic
documentation failure mode. The project has real architectural rules (money,
tenancy, idempotency, append-only audit, outbox delivery, provider ports), a
contradictory legacy documentation set, and six tasks with hidden trap tests.

The pilot is not a benchmark of the model. It is a controlled comparison of two
context regimes with the same model and the same tasks.

## Layout

```
fixture/            the application, legacy docs and the baseline AGENTS.md
steadfast/          the seeded .steadfast memory and the steadfast AGENTS.md
tasks/              one prompt per task
tasks.json          task metadata: paths, scope, related decisions, trap
traps/              hidden tests copied in only at scoring time
run.mjs             prepare a temp repo, run one agent, score it
score.mjs           visible tests + trap + check + scope + context tokens
report.mjs          render results.json as RESULTS.md
runs/               raw agent transcripts and per-run scores (gitignored)
results.json        aggregated results (committed)
```

## Modes

- **baseline** — the fixture as-is. `AGENTS.md` tells the agent to read every
  file under `legacy-docs/` (about 10.5k tokens, with four contradictions).
- **steadfast** — the same fixture plus the seeded `.steadfast/`, the steadfast
  `AGENTS.md`, and the installed skill. The contract says to run `context` and
  not read the legacy docs.

The agent prompt is the same in both modes. Only `AGENTS.md` and the memory
layer differ.

## Run

```bash
# one task, both modes
node run.mjs --mode both --only task1

# everything, fresh results
node run.mjs --fresh --mode both

# one mode
node run.mjs --mode steadfast
```

Options:

- `--model <provider/model>` — default `opencode-go/deepseek-v4.1-flash`
- `--only task1,task2` — subset
- `--fresh` — clear `runs/`, `results.json` and the cached package
- `--dry` — prepare and score without running an agent (harness check)

Each run creates a fresh temporary repository, installs the local package in
steadfast mode, commits a base, runs the agent with `--standalone`, then scores.

## Scoring

A run passes when all of the following hold:

- the visible suite passes;
- the hidden trap for the task passes (tasks 1–4);
- `steadfast check --strict --diff <base>` passes in steadfast mode;
- every changed path is inside the task's allowed scope;
- the task-specific check passes (task 5: a successor record; task 6:
  `prettier` plus a decision record).

`missingRules` is computed from the task's canonical path set. It measures
whether the framework's selection put a related decision in the pack, not
whether the agent read it.

## Limitations

- The fixture and the legacy docs are synthetic. The baseline is intentionally
  contradictory, which is realistic for a drifted documentation set but is still
  a constructed baseline.
- One trial per cell. The pass rate is a smoke test, not a statistical result.
- Token cost is measured as the context the contract tells the agent to load
  (pack header vs. legacy docs), not as the provider's billed tokens.
- Task 5 is memory-only; the baseline has no equivalent layer and is reported as
  n/a.
- The agent can read the visible tests. The trap tests are copied in only after
  the agent finishes.
