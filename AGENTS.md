# AGENTS.md

## Project

Kaktus Účto 3.2 module for the TAXY Connector. A TypeScript CLI that:

1. **reads** suppliers and received invoices from Kaktus DBF files (`kaktus/DATA/`),
2. **writes** received invoices from TAXY (`taxy/doklady-k-zapisu.json`) via the Kaktus XML batch import and reports the outcome of each document.

Spec: `ZADANI.md` (Czech). Verified Kaktus behavior, input data analysis and decisions: `docs/findings.md`.

Runs unattended at hundreds of accounting offices on Windows, against live client books. Priorities, in order:

1. **Never corrupt data:** no double writes, no lost documents, nothing in the wrong company.
2. **Report truthfully:** every document ends in an explicit status with a reason. "Unknown" is a valid status; silent success is not.
3. Everything else.

## Sources of truth

| Question | Source |
|---|---|
| What to build | `ZADANI.md` |
| How Kaktus actually behaves | `docs/findings.md` (experimentally verified only) |
| How Kaktus should behave per vendor | `kaktus/prirucka/` (2014, wrong in places) |

Observed behavior wins over the manual.

## Hard rules

- Never write DBF files. Read DBF directly; write only via `node kaktus/kaktus.cjs import`. Sole exception: guarded restore from our own pre-batch backup (`docs/findings.md`, Decisions → Recovery).
- The simulator is a black box: do not read, modify or deminify `kaktus/kaktus.cjs`. Learn its behavior by experiment.
- `kaktus/`, `taxy/` and `ZADANI.md` are task inputs: do not edit. Run experiments on a copy (`mktemp -d`). If repo data changes, run `node kaktus/kaktus.cjs obnovit` and check `git status`.
- No claims about Kaktus without an experiment. Record new findings in `docs/findings.md` before building on them.
- Never invent accounting data. Missing or conflicting data means: do not write, return a status with a reason. Propose accounting decisions to the developer; do not make them silently.
- Never commit, push or rewrite git history. End each step by proposing `git add` / `git commit` commands; the developer commits.
- Out of scope: servers, web, databases, network. No secrets in the repo.

## Kaktus pitfalls

Details and evidence in `docs/findings.md`.

- DBF encoding is CP852; batch and response are Windows-1250.
- Import does not detect duplicates: idempotency is our job.
- Import processes at most 20 documents per batch and silently drops the rest: the response must contain one `Doklad` per sent document.
- Import is not atomic, and concurrent imports into one company corrupt data: one import per company at a time, verify by re-reading DBF.
- Over-long values are silently truncated: enforce field lengths before writing.

## Glossary

| Czech | Code | Meaning |
|---|---|---|
| firma, účetní jednotka | `company` | client company; row in `FIRMY.DBF`, id `0001` |
| faktura přijatá (FP) | `receivedInvoice` | supplier invoice; `FAKPRI.DBF` |
| dodavatel, partner | `supplier`, `partner` | `ADRESAR.DBF` |
| dávka | `batch` | import XML, one company per batch |
| odpověď | `importResponse` | XML returned by the import |
| DUZP | `taxPointDate` | tax point date; determines the accounting period |
| VS | `variableSymbol` | payment reference |

## Code conventions

- TypeScript `strict`, Node 18+ compatible.
- Minimal dependencies; justify each in its commit message.
- Money as integer haléře, never float arithmetic. Dates as validated `YYYY-MM-DD` strings.
- English everywhere: code, comments, docs, CLI output, commit messages. Only text stored in Kaktus (read by Czech accountants) is Czech.
- Docs are concise: no filler sentences.
- Validate external input (TAXY JSON, DBF, import response) at the boundary. Never swallow errors.
- Keep pure logic (mapping, validation, parsing) separate from I/O (files, simulator process).

## Workflow

1. Read `ZADANI.md`, `docs/findings.md` and the affected code before changing anything.
2. Work in small verifiable steps; run tests after each and show the result.
3. Report what is verified (and how), what is unverified, what is assumed.
4. Log AI mistakes and developer corrections in `docs/ai-log.md`.

## Commands

```
npm test                                         # build + all tests
npm run read -- [--data <dir>] [--out <file>]    # default kaktus/DATA → output/read.json

node kaktus/kaktus.cjs import <batch.xml> [response.xml]
node kaktus/kaktus.cjs obnovit                   # reset kaktus/DATA
node kaktus/kaktus.cjs zamknout <firma>          # accountant opens the company
node kaktus/kaktus.cjs odemknout <firma>         # accountant closes it
```

## Deliverable limits

- `README.md` max 400 words (`wc -w README.md`).
- Each of the two answers max 5 sentences.
- Commit the output of a real run (read and write).
