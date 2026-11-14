# Labeling guide

Written before any data was collected. Used for the hand-labeled gold set.

## Unit

One row = one claim + the one source cited for it.
If a sentence cites two sources, it becomes two rows.
A claim with no citation is recorded as `uncited` and is not labeled.

## Labels

| Label | Use when |
|---|---|
| `supported` | The cited page states the claim, including its specific details (numbers, dates, names, scope). |
| `partial` | The page backs the main point, but a specific detail is missing, different, or stated more weakly than the claim. |
| `unsupported` | The page does not state the claim, or contradicts it. This includes pages that are on the right topic but never say it. |
| `unchecked` | The page could not be read: dead link, paywall, login wall, blocked, or not text. Never count these as unsupported. |

## Rules

1. Judge only against the cited page. Do not use your own knowledge or other pages.
2. A claim that is true but not on the cited page is `unsupported`.
3. For `supported` and `partial`, copy the exact passage that backs the claim into the `evidence` column.
4. For `partial`, write which detail is missing or different in the `note` column.
5. Label before looking at the checker's verdict for that row.
6. If unsure between two labels, pick the lower one and add a note.

## Sampling

- Draw rows at random from the full set of claim-source pairs, not by picking interesting ones.
- Take an equal number per model, and an equal number of Nigeria and global rows.
- Target: 60 rows. Minimum: 40.

## Columns

`row_id, question_id, model, claim, source_url, label, evidence, note`
