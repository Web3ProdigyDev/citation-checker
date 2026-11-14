# Citation checker

When an AI assistant cites a source, does the source actually say that?

This tool takes saved AI answers, pulls out each factual claim and the link cited for it, reads the linked page, and marks the citation `supported`, `partial` or `unsupported`, with the exact passage as evidence.

Built for the Apart Research AI x Epistemics Sprint (Trust Infrastructure track), 13 to 15 November 2026. All code in this repo was written during the sprint.

## What is here

| File | What it is |
|---|---|
| `check.ts` | The checker. One file, no runtime dependencies. |
| `questions.csv` | 30 questions: 15 matched pairs, one Nigeria-specific and one global, across farming, finance and health. |
| `answers/` | The AI answers that were checked, one file per model and question. |
| `LABELING.md` | Rules used for the hand-labeled gold set. Written before data collection. |
| `gold.csv` | Hand labels for a random sample of citations. |
| `results/` | Checker output, summary tables and scores against the gold set. |

## How it works

1. **Claims.** A model splits each answer into standalone factual claims and attaches the URLs cited for each. URLs that do not appear in the answer are dropped.
2. **Sources.** Each cited page is fetched once. The text is stored locally with a SHA-256 hash and a timestamp, so a verdict can be tied to the exact text it was made against.
3. **Excerpts.** For long pages, the passages that best match each claim are selected by weighted keyword overlap.
4. **Verdict.** A judge model reads the claim and the excerpts and returns a verdict with a quote. The quote is then searched for in the page text; quotes that are not found are flagged.

PDF sources are read with `pdftotext`. Pages that cannot be read (dead link, paywall, blocked, scanned PDF) are recorded as `unchecked` with the reason. They are never counted as unsupported.

A keyword-only baseline judge (`--judge baseline`) is included for comparison.

## Run it

Needs Node 18 or newer, and `pdftotext` for PDF sources (`sudo apt install poppler-utils` on Ubuntu or WSL).

```bash
npm install
cp .env.example .env        # add your Gemini API key and model ID

npx tsx check.ts run        # check every answer in answers/ (safe to re-run; progress is cached)
npx tsx check.ts summary    # result tables
npx tsx check.ts sample 60  # draw a blind random sample to label -> gold.csv
npx tsx check.ts score      # compare hand labels with the checker
```

Answers are read from `answers/<model>/<question id>.md`, for example `answers/chatgpt/F1-NG.md`.

## Results

To be added.

## Limits

To be added. See the report.