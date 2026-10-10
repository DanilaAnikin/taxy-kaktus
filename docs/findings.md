# Findings

Basis for the design and the README. Method: the simulator (v3.2.1, Node 26) was explored as a black box, without reading its source. Experiments ran on a copy of the package: `obnovit` → batch → DBF diff before/after.

## Kaktus data (DBF)

| # | Finding | Manual | Evidence |
|---|---|---|---|
| D1 | DBF encoding is **CP852** (language driver `0x64`). | Windows-1250 | `FIRMY.DBF` name decodes as „Truhl ýstvˇ“ in cp1250, „Truhlářství“ in CP852 |
| D2 | `ADRESAR.ICO` is numeric `N8`, so leading zeros are lost (`242659` = IČO 00242659, `4512375`). `FIRMY.ICO` is text `C8`. | – | field headers |
| D3 | Contains **deleted records** (`*` flag): ADRESAR 0001 #20, FAKPRI 0001 #20 and #39. | – | record dump |
| D4 | **Duplicate partners:** 0001 #7 „Pila Ořech s.r.o.“ and #19 „PILA OŘECH SRO“, both IČO 90100077. | – | record dump |
| D5 | Field sizes: `NAZEV C40`, `CISLODOD C20`, `VS C10`, `TEXT C50`, `POZN C60`; amounts `N12.2`, rate `N10.4`, dates `D8` (empty `DATUHR` = unpaid). | 3 sizes only | field headers |
| D6 | Foreign-currency amounts are stored in the document currency plus rate (FP260028: 1840.50 EUR, 24.78). CZK has rate `1.0000`. | – | record dump, EUR import |
| D7 | In all 60 existing invoices, `CELKEM` equals the sum of bases and VAT exactly. | – | record dump |

## Batch import

| # | Finding | Manual | Evidence |
|---|---|---|---|
| I1 | Batch is **always read as Windows-1250**; the XML `encoding` declaration is ignored. A UTF-8 batch returns OK and stores mojibake. Characters outside cp1250 (`→`) are stored as `?`. Response is Windows-1250. | Windows-1250 | UTF-8 batch with cp1250 / UTF-8 / no declaration |
| I2 | **No duplicate detection.** Same document twice in one batch, in two batches, or already in the book (2026-0931, FP260045): written again. | – | 4 experiments |
| I3 | Processes **only the first 20 documents** (rejected ones count). The rest is ignored silently: exit 0, response lists 20 `Doklad`. | – | batches of 21, 25, 300 |
| I4 | **Not atomic.** Documents are written one by one. Killing the process leaves part of the batch written, no response, no `IMPORT.LOG` line. **7 of ~1000 kills left `FAKPRI.DBF` empty (0 B).** | – | ~1000 kills at random times |
| I5 | **Concurrent imports** into one company (import does not lock) lose records and duplicate FP numbers; 4 of 16 runs corrupted the DBF and crashed the simulator (out of memory). | – | 2 × 20-document imports in parallel |
| I6 | An open company is marked by `DATA/<firma>/FIRMA.LCK` („uživatel JANA, stanice UCETNI-PC2“). Import then exits 3, message on stderr, no response, nothing written. Other companies import normally. | "import not possible" | `zamknout` → import → `odemknout` |
| I7 | **Exit codes:** `0` processed (even if all rejected), `2` unreadable batch (invalid XML, unescaped `&`), `3` company open, `4` unknown or missing company. A response is produced only on `0`. | `0` / `1` | targeted batches |
| I8 | Checks: **E101** required field missing or empty · **E120** date must be valid `YYYY-MM-DD` · **E130** amount with `.`, no spaces, max 2 decimals (negative allowed) · **E140** IČO digits only, max 8 (no checksum check; all TAXY IČOs have a valid one) · **E210** tolerance **±1.00** · **E220** DUZP outside 2026 · **E230** foreign currency without rate, rate with `,` or `0` · **E100** unknown document element (other documents still processed). | code list | targeted batches |
| I9 | **Not checked:** VAT vs rate (1000 + 200 = 1200 passes), currency validity (`XYZ` passes, `eur` stored as `EUR`), `verze` attribute. | E230 "invalid currency" | targeted batches |
| I10 | Over-long values are **silently truncated**: name 40, text 50, supplier number 20, VS 10. | – | long values |
| I11 | Partner lookup by IČO is **numeric** (`00242659` = `242659`); with duplicate IČO the lowest ID wins; an existing partner is **never updated** (new name/address ignored). Without IČO: **exact** name match (case, spaces), otherwise a new partner is created. | "by IČO, else by name" | IČO with/without zeros, duplicate IČO, changed name, name variants |
| I12 | Missing `DatumZdanPlneni` defaults to issue date. `DatumSplatnosti` is optional. | matches | batch without them |
| I13 | Document number continues after the last book record, deleted ones included (46 records → FP260047). | "next free number" | manual's sample batch |
| I14 | Response goes to `<batch>.odpoved.xml` or the second argument. `IMPORT.LOG` gets `date time;file;zapsano=N;odmitnuto=M` after completion. | matches | default and custom path |
| I15 | The open period (2026) is internal to Kaktus: unchanged with the clock set to 2025 or 2027, and with DBF header dates, last FP number or last DUZP moved to 2027. | – | shifted process clock, edited DBF copy |

## TAXY input (`taxy/doklady-k-zapisu.json`)

37 documents, all `faktura_prijata` / `schvaleno`: client 4172 (company 0001) 30, client 4180 (0002) 6, unknown client 5033 one. VAT matches the rate everywhere.

| # · number | Issue | Kaktus would |
|---|---|---|
| 7 · 2026/778 | client **5033 not in `klienti.json`** | – |
| 13 · MO-26-07731 | client 4172 (carpentry), **buyer is the bakery** (IČO 90581130) | write to the wrong company |
| 6, 15 · 260914 | **same invoice twice** in TAXY (different `id`, second „Fwd: faktura 260914“) | write twice |
| 5 · 2026-0931 | **already in Kaktus** (0001 FP260045) | write again |
| 16 · NAJ-2026-09 | **already in Kaktus** (0001 FP260042); VS differs (`202609` vs `2026009`), match is IČO + number | write again |
| 23 · FV-2609-0188 | **already in Kaktus** (0002 FP260012) | write again |
| 12 · FV26001877 | in Kaktus as **deleted** FP260039 „Frézy - zadáno na špatnou firmu“; TAXY buyer is 0001 | write again |
| 11 · 2025-3391 | DUZP **2025-12-29** | E220 |
| 19 · (none) | **missing document number** (VS 2600412) | E101 |
| 25 · 26100031 | bases + VAT 2440.57, total 2441 (rounding 0.43) | accept, total ≠ sum |
| 14 · VF-0931/26 | supplier name 63 chars, `→` in text | truncate name, store `?` |
| 3 · FV2600318 | `&` in name, `<září>` in text | fine if XML is escaped |
| 8 · RE-2026-4471 | EUR with rate, supplier without IČO (found by name) | fine |
| 9, 34 | IČO with leading zeros | fine (numeric match) |
| 24 · 2026-0288 | IČO 90100077 has two partners | uses #7 |
| 29 · KP-26-5512 | three VAT rates (21, 12, 0) | fine |
| 3, 14 | new suppliers | create partner |

Company 0001 has 30 documents, more than one batch holds (I3).

## Decisions

**Rounding (doc 25).** A CZK total in whole crowns that differs from bases + VAT by at most 0.50 is treated as rounding: bases and VAT are written as invoiced, the difference goes to `Zaklad0`. Any other mismatch is rejected; Kaktus's ±1.00 tolerance is not relied on.
*Why:* rounding to whole crowns is not part of the VAT base (§ 36(5) ZDPH, since 2021-10-01), so VAT must match the supplier's invoice and the total must match the amount payable. ERPs book rounding as a separate non-VAT item; `Zaklad0` is Kaktus's only non-VAT field. Keeps total = sum, as in all existing invoices (D7).

**Deleted match (doc 12).** A document matching a deleted Kaktus record (same supplier + number) is not written; status `needs_review` with the Kaktus number and text.
*Why:* Kaktus is the system of record and the deletion was a deliberate accountant action with a stated reason. Automation must not override a human correction; AP automation routes such conflicts to an exception queue, and SAP S/4HANA's duplicate check also matches cancelled documents.

**Open period.** Not pre-checked. E220 is reported as `rejected` with reason "period closed".
*Why:* the period lives inside Kaktus (I15); re-implementing a rule we cannot read would drift from it.
