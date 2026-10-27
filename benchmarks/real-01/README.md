# Real-project pilot: steam-saat

A production-shaped monorepo, not a synthetic fixture. The goal was to migrate
one large architecture document into decisions and run real job-module tasks
from the pack only.

## Setup

- Repository: `steam-saat`
- Worktree: `steam-saat-steadfast-pilot`
- Branch: `steadfast-pilot`, based on `0bea3ad`
- Pilot head: `8eb26eb`
- Source document: `docs/job-mimari.md` (about 3.2k tokens)
- Memory: 18 decisions, 4 invariants, 5 advisory rules

The branch is intentionally separate from `development` so the baseline and
the migrated tree can be compared. It is not merged yet.

## Measurements

| Measure | Document baseline | Pack |
| --- | ---: | ---: |
| Module context | 3,226 tokens | 1,331 tokens |
| Per-task context | 3,226 tokens | 149–608 tokens |
| Five contract tasks | ~8,942 tokens | ~1,667 tokens |

The pack was about 5x cheaper across the five task set. The document was retired
after migration; `check` fails if it reappears.

## Findings

1. **Keeping both layers causes drift.** Adding the `maintenance.cleanup` job
   made the architecture document incomplete immediately. The document was
   retired rather than updated.
2. **The budget is per task, not per project.** A narrow path set kept packs
   small as the monorepo grew.
3. **Fail-closed is the right default.** Stopping on an incomplete pack is
   better than silently dropping a rule.
4. **`enforced_by` remains declarative.** Five of the 18 rules were advisory in
   the pilot; tests or linters must be wired for the rest.
5. **Migration is the hard part.** The tool manages memory after conversion;
   turning prose into decisions is still manual work.

## Current state

- The migration and the new job work live on `steadfast-pilot` (`8eb26eb`).
- `development` still has `docs/job-mimari.md`; merge or retire it there.
- `doctor` reports five advisory rules: ADR-0012 through ADR-0016.
- The pilot branch has not been pushed or reviewed.

## Limitations

One project, one trial per task, one model. This is a smoke test for the loop
outside a synthetic fixture, not a statistical result. Token counts measure the
required context, not billed tokens.
