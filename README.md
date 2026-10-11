# Kaktus module for the TAXY Connector

Reads Kaktus DBF files; writes TAXY invoices through the Kaktus XML import. TypeScript, Node 18+.

## Run

```
npm ci
npm run read                    # kaktus/DATA → output/read.json
npm run write                   # taxy/doklady-k-zapisu.json → Kaktus, output/write-report.json
node kaktus/kaktus.cjs obnovit  # reset after a write
npm test                        # 106 tests
```

`node dist/src/cli.js` lists options. Exit codes: 0 settled, 1 retry needed, 2 invalid input. `output/`: my run and a rerun. CI tests Windows and Linux.

## What it does

- Read: TAXY document schema; a damaged DBF fails its company, never partial data.
- Write: every document ends with a status and, unless written, a reason.
- No double writes: each invoice carries its TAXY id, matched before every batch.
- `written` only after reading the record back from the DBF.
- One run per company; a company open in Kaktus is `deferred`.
- After a crash or power loss, the next run recovers from a journal and backup made before each import.

Not done: other document types, edits of written documents, VAT payer check.

## Kaktus findings

Black box: I did not read the simulator's source. Details: `docs/findings.md`.

- DBF is CP852, batches Windows-1250 (manual: both Windows-1250).
- No duplicate check; documents after the 20th in a batch are silently ignored.
- Not atomic: a kill leaves a batch partly written, sometimes a table empty.
- Parallel imports into one company corrupt it.
- Over-long values are silently truncated.
- Partner matching: IČO numerically, else exact name among partners without IČO; never updated.

## Decisions made for you

- Unknown client, or buyer not the client's company: rejected, never rerouted.
- Whole-crown rounding up to 0.50 goes to `Zaklad0`; other mismatches are rejected.
- Duplicates match ignoring case, accents and punctuation; a deleted or differing match is `needs_review`.
- Number, VS, IČO and DIČ are never altered; text is transliterated and truncated with a warning.
- VAT from a supplier without DIČ: written with a warning.
- Our backup restores a table damaged by our import only if nobody touched the data since.

## Before production

- Test the real KAKTUS.EXE on copies of client books: exit codes, `/IMPORT`, encodings, limits, large books, network folders, antivirus.
- Confirm the decisions with accountants.
- Monitor `needs_review`, `error` and recoveries.

AI: `AGENTS.md`, `docs/ai-log.md`. Answers, time and amount: `docs/answers.md`.
