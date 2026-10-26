# Steadfast pilot: ledgerline

Synthetic multi-tenant billing ledger. Same model, same tasks, two context regimes plus a retired-docs probe.

## Summary

| Mode | Tasks | Passed | Avg context tokens |
| --- | ---: | ---: | ---: |
| baseline (legacy docs) | 6 | 5 | 10459 |
| steadfast | 7 | 7 | 681 |
| steadfast-retired (task7 probe) | 1 | 1 | 777 |

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
| task7 | baseline | fail | 10459 | - | 0 | 0 |
| task7 | steadfast | pass | 777 | - | 0 | 0 |
| task7 | steadfast-retired | pass | 777 | - | 0 | 0 |

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
| task7 | baseline | 0 | 0 | 0 | 82 |
| task7 | steadfast | 10 | 17 | 10 | 38 |
| task7 | steadfast-retired | 8 | 13 | 6 | 2 |

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
- Task 7 is the non-inferable probe: the legacy docs say the refund cap belongs to the reporting job, while the pack says the API enforces it. The `steadfast-retired` mode deletes the legacy docs and relies on the pack alone.

## Hardened probe (task7)

The legacy docs place the refund cap in the nightly reporting job; the pack places it in the API.
The baseline followed the docs and failed the per-charge cap trap. The pack passed it with the docs present and after `steadfast retire` deleted them. The retired transcript contains no legacy-doc reads.

## Interpretation

- The baseline passed 5 of 6 applicable tasks. It failed task7, the non-inferable refund cap, where the docs explicitly put the check in the reporting job.
- The pack passed all 7 tasks, including task7, in both docs-present and docs-retired modes.
- Across comparable tasks the context cost fell from 10,459 to 681 tokens (15.4x).
- In the main six tasks the legacy docs were contradictory but the code and visible tests anchored the truth, so both regimes passed. The win there was cost, not correctness.
- The steadfast agents still mentioned or read legacy docs in several main tasks. The pack average is the required context, not total token spend. The retired probe removes the docs entirely.
- Staleness, duplicate-topic and edited-history detection are deterministic and exist only with the memory layer.
- The retired mode is filesystem-level read confinement: the docs are deleted and `check` fails if they reappear.

