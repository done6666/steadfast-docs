# Steadfast pilot: ledgerline

Synthetic multi-tenant billing ledger. Same model, same tasks, two context regimes.

## Summary

| Mode | Tasks | Passed | Avg context tokens |
| --- | ---: | ---: | ---: |
| baseline (legacy docs) | 5 | 5 | 10459 |
| steadfast | 6 | 6 | 665 |

## Per task

| Task | Mode | Result | Context tokens | Missing rules | Scope violations | Agent exit |
| --- | --- | --- | ---: | --- | --- | ---: |
| task1 | baseline | pass | 10459 | - | 0 | 0 |
| task1 | steadfast | pass | 640 | - | 0 | 0 |
| task2 | baseline | pass | 10459 | - | 0 | 0 |
| task2 | steadfast | pass | 328 | - | 0 | 0 |
| task3 | baseline | pass | 10459 | - | 0 | 0 |
| task3 | steadfast | pass | 514 | - | 0 | 0 |
| task4 | baseline | pass | 10459 | - | 0 | 0 |
| task4 | steadfast | pass | 431 | - | 0 | 0 |
| task5 | steadfast | pass | 1011 | - | 0 | 0 |
| task6 | baseline | pass | 10459 | - | 0 | 0 |
| task6 | steadfast | pass | 1068 | - | 0 | 0 |

## Behavior signals

Counts are mentions in the agent transcript, not exact tool-call totals.

| Task | Mode | context | check | verify | legacy-docs |
| --- | --- | ---: | ---: | ---: | ---: |
| task1 | baseline | 0 | 0 | 0 | 94 |
| task1 | steadfast | 10 | 16 | 8 | 48 |
| task2 | baseline | 0 | 0 | 0 | 80 |
| task2 | steadfast | 10 | 7 | 4 | 36 |
| task3 | baseline | 0 | 0 | 0 | 96 |
| task3 | steadfast | 22 | 17 | 10 | 84 |
| task4 | baseline | 0 | 0 | 0 | 96 |
| task4 | steadfast | 12 | 10 | 6 | 4 |
| task5 | steadfast | 14 | 20 | 10 | 90 |
| task6 | baseline | 0 | 0 | 0 | 135 |
| task6 | steadfast | 4 | 9 | 4 | 8 |

## Staleness controls

| Control | Result | Code |
| --- | --- | --- |
| stale fingerprint | detected | fresh/stale |
| duplicate topic | detected | graph/duplicate-topic |
| edited history | detected | history/edited-record |

The legacy docs contain 4 contradictions and no detector.

## Notes

- Baseline context tokens are the sum of `legacy-docs/**/*.md`, the set the baseline `AGENTS.md` tells the agent to read.
- Steadfast context tokens are the `context --json` result for the task's canonical path set.
- `missingRules` lists related decisions (active or rejected) absent from the canonical pack. It measures framework coverage, not whether the agent read them.
- Task 5 is memory-only; the baseline has no equivalent layer and is reported as n/a.
- Task 6 baseline passes the package.json criterion only; it has no decision layer.

## Interpretation

- Both regimes passed every task on this model. The pilot does not show a correctness win; it shows a **15.7x** context-cost win.
- The legacy docs were contradictory, but the code and visible tests anchored the truth. A capable model reconciled them without the memory layer.
- The steadfast agents still mentioned or read legacy docs in several tasks. The 665-token average is the required pack, not the agent's total token spend.
- Staleness, duplicate-topic and edited-history detection are deterministic and exist only with the memory layer.
- Read discipline is a soft control. The next hardening step is an explicit no-other-docs contract and, where the platform allows it, tool-level read confinement.

