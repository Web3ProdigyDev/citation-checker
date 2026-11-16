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

60 answers (ChatGPT and Perplexity, 30 matched Nigeria/global questions on farming, finance and health), checked with Gemini 3.5 Flash-Lite as the judge. Claim level: a claim counts once, by its best readable source.

| Assistant | Checked claims | Supported | Partial | Unsupported (95% CI) |
|---|---|---|---|---|
| ChatGPT | 303 | 66% | 14% | 20% (16 to 25%) |
| Perplexity | 284 | 73% | 11% | 17% (13 to 21%) |

| Unsupported | Global | Nigeria |
|---|---|---|
| ChatGPT | 25% | 15% |
| Perplexity | 13% | 21% |

- 15% of cited claims could not be checked (sites refused automated access or returned too little text). These are never counted as unsupported.
- Of 347 unsupported citations, 78% were "not stated" on the page and 21% pointed to a landing or download page.
- Against reference labels on 38 claim-source pairs (`gold.csv`), the checker agreed 82% of the time (95% CI 67 to 91%); a keyword-only baseline agreed 42%. The reference labels were made by a second AI model reading each saved page, not by a human.

Full tables: `results/summary.gemini.md`. Scores: `results/score.gemini.md`, `results/score.baseline.md`.

## Limits

- Small study: 30 questions, two assistants, one collection date each.
- One judge model, chosen for its free quota. It never uses "partial" in practice, so its unsupported rate is likely somewhat overstated.
- For a third of supported or partial verdicts, the judge's quote was not found word for word on the page.
- Pages that load their text with JavaScript can look empty to the checker.
- The tool checks whether the cited page supports a claim, not whether the claim is true.

See the report for details.