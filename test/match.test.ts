import assert from "node:assert/strict";
import { test } from "node:test";
import type { Book } from "../src/kaktus/company.js";
import { findInBook, linkSupplier, looseKey, naturalKeys, verifyRecord } from "../src/write/match.js";
import { book, taxyDocument, writePlan } from "./taxy.js";

test("finds invoices the accountant already entered, by supplier and number", async () => {
  const company1 = await book("0001");
  const sameData = await writePlan(taxyDocument("doc_c36efaf63f"));
  assert.deepEqual(summary(findInBook(sameData.ref.id, sameData.invoice, company1)), ["exists", "FP260045", []]);

  const otherSymbol = await writePlan(taxyDocument("doc_00a5091cef"));
  assert.deepEqual(summary(findInBook(otherSymbol.ref.id, otherSymbol.invoice, company1)), [
    "exists",
    "FP260042",
    ["variable symbol: Kaktus 2026009, TAXY 202609"],
  ]);

  const bakery = await writePlan(taxyDocument("doc_fd03b52d28"));
  assert.deepEqual(summary(findInBook(bakery.ref.id, bakery.invoice, await book("0002"))), ["exists", "FP260012", []]);
});

test("a number or supplier retyped differently still matches", async () => {
  const company1 = await book("0001");
  const plan = await writePlan(taxyDocument("doc_c36efaf63f"));
  const retyped = edit(company1, "FP260045", { supplierNumber: "2026 / 0931" });
  assert.deepEqual(summary(findInBook(plan.ref.id, plan.invoice, retyped)), [
    "exists",
    "FP260045",
    ["supplier number: Kaktus 2026 / 0931, TAXY 2026-0931"],
  ]);

  const partnerId = company1.invoices.find((record) => record.number === "FP260045")!.partnerId;
  const withoutIco = {
    ...company1,
    partners: company1.partners.map((partner) =>
      partner.id === partnerId ? { ...partner, ico: null, name: "Železářství Čáp, s. r. o." } : partner,
    ),
  };
  assert.equal(findInBook(plan.ref.id, plan.invoice, withoutIco).kind, "exists", "partner entered without IČO");
  assert.equal(looseKey("ŽELEZÁŘSTVÍ ČÁP s.r.o."), looseKey("Železářství Čáp, s. r. o."));
  assert.notEqual(looseKey("2026-0931"), looseKey("2026-0913"));
});

test("a deleted match, different data or a duplicate needs a human", async () => {
  const company1 = await book("0001");
  const deleted = await writePlan(taxyDocument("doc_61ed535421"));
  assert.deepEqual(summary(findInBook(deleted.ref.id, deleted.invoice, company1)), ["deleted", "FP260039", []]);

  const changed = await writePlan(
    taxyDocument("doc_c36efaf63f", { rozpisDph: [{ sazba: 21, zaklad: 3300, dph: 693 }], celkem: 3993 }),
  );
  assert.deepEqual(summary(findInBook(changed.ref.id, changed.invoice, company1)), [
    "conflict",
    "FP260045",
    ["total: Kaktus 3950.00, TAXY 3993.00"],
  ]);

  const plan = await writePlan(taxyDocument("doc_c36efaf63f"));
  const original = company1.invoices.find((record) => record.number === "FP260045")!;
  const twice = { ...company1, invoices: [...company1.invoices, { ...original, id: 99, number: "FP260099" }] };
  const match = findInBook(plan.ref.id, plan.invoice, twice);
  assert.equal(match.kind, "duplicate");
  assert.deepEqual(match.kind === "duplicate" && match.records.map((record) => record.number), [
    "FP260045",
    "FP260099",
  ]);
});

test("our own records are found by TAXY id first; changed core data is a conflict", async () => {
  const company1 = await book("0001");
  const plan = await writePlan(taxyDocument("doc_b0e22b273a"));
  const record = {
    ...company1.invoices[0]!,
    note: "TAXY doc_b0e22b273a",
    supplierNumber: "other",
    total: plan.invoice.total,
    currency: "CZK",
    issueDate: plan.invoice.issueDate,
  };
  const ours = (invoices: (typeof record)[]): Book => ({ ...company1, invoices });
  assert.equal(findInBook(plan.ref.id, plan.invoice, ours([record])).kind, "exists");
  assert.equal(findInBook(plan.ref.id, plan.invoice, ours([{ ...record, deleted: true }])).kind, "deleted");
  assert.equal(findInBook(plan.ref.id, plan.invoice, ours([{ ...record, total: 100 }])).kind, "conflict");
  assert.equal(findInBook(plan.ref.id, plan.invoice, ours([record, { ...record, number: "FP2" }])).kind, "duplicate");
  assert.equal(findInBook(plan.ref.id, plan.invoice, company1).kind, "none");
});

test("copies of one invoice share a key even when one lacks IČO or spells the supplier differently", async () => {
  const first = await writePlan(taxyDocument("doc_3c0d1615f6"));
  const forwarded = await writePlan(taxyDocument("doc_a88ae33500"));
  const retyped = await writePlan(
    taxyDocument("doc_a88ae33500", { dodavatel: { ico: null, nazev: "KOVÁNÍ ŘÍHA spol. s r. o." } }),
  );
  const shares = (a: string[], b: string[]) => a.some((key) => b.includes(key));
  assert.ok(shares(naturalKeys(first.invoice), naturalKeys(forwarded.invoice)));
  assert.ok(shares(naturalKeys(first.invoice), naturalKeys(retyped.invoice)));
  const other = await writePlan(taxyDocument("doc_3c0d1615f6", { cisloDokladu: "260915" }));
  assert.ok(!shares(naturalKeys(first.invoice), naturalKeys(other.invoice)));
});

test("predicts the Kaktus partner and warns about missing or different DIČ", async () => {
  const { partners } = await book("0001");
  const regular = linkSupplier((await writePlan(taxyDocument("doc_b0e22b273a"))).invoice, partners);
  assert.deepEqual([regular.partnerId, regular.warnings], [1, []]);

  const duplicateIco = linkSupplier((await writePlan(taxyDocument("doc_c34d189eac"))).invoice, partners);
  assert.equal(duplicateIco.partnerId, 7, "of two partners with one IČO, the lowest id (findings I11)");

  const newSupplier = linkSupplier((await writePlan(taxyDocument("doc_49aa18c650"))).invoice, partners);
  assert.equal(newSupplier.partnerId, null);

  const withoutDic = await writePlan(taxyDocument("doc_8c8a7f4e87"));
  assert.deepEqual(
    linkSupplier(withoutDic.invoice, partners).warnings.map((warning) => warning.kod),
    ["SUPPLIER_WITHOUT_DIC"],
  );

  const otherDic = await writePlan(taxyDocument("doc_b0e22b273a", { dodavatel: { dic: "CZ90100026" } }));
  assert.deepEqual(
    linkSupplier(otherDic.invoice, partners).warnings.map((warning) => warning.kod),
    ["SUPPLIER_DIC_DIFFERS"],
  );
});

test("a supplier without IČO links only to a partner without IČO, by name, never by DIČ alone", async () => {
  const { partners } = await book("0001");
  const link = async (dodavatel: Record<string, unknown>) =>
    linkSupplier((await writePlan(taxyDocument("doc_39ad40f7b2", { dodavatel }))).invoice, partners);
  const summary = ({ invoice, partnerId, warnings }: Awaited<ReturnType<typeof link>>) => [
    invoice.supplier.name,
    partnerId,
    warnings.map((warning) => warning.kod),
  ];

  assert.deepEqual(summary(await link({})), ["Holz Bauer GmbH", 16, []]);
  assert.deepEqual(summary(await link({ nazev: "HOLZ BAUER GMBH" })), ["Holz Bauer GmbH", 16, ["LINKED_BY_NAME"]]);
  assert.deepEqual(summary(await link({ nazev: "Holz-Bauer GmbH", dic: null })), [
    "Holz Bauer GmbH",
    16,
    ["LINKED_BY_NAME"],
  ]);
  assert.deepEqual(summary(await link({ nazev: "Holz-Bauer GmbH", dic: "DE111111111" })), [
    "Holz-Bauer GmbH",
    null,
    [],
  ]);
  assert.deepEqual(
    summary(await link({ nazev: "Bauer Logistik GmbH" })),
    ["Bauer Logistik GmbH", null, []],
    "VAT groups share one DIČ",
  );
  assert.deepEqual(
    summary(await link({ nazev: "Kování Říha, spol. s r.o.", dic: "CZ90100034", stat: "CZ" })),
    ["Kování Říha, spol. s r.o.", null, ["SUPPLIER_WITHOUT_ICO"]],
    "Kaktus looks up names only among partners without IČO",
  );
});

test("a written record must be linked to the predicted partner, or to a new one", async () => {
  const company1 = await book("0001");
  const plan = await writePlan(taxyDocument("doc_b0e22b273a"));
  const known = new Set(company1.partners.map((partner) => partner.id));
  const record = {
    ...company1.invoices[0]!,
    ...{ supplierNumber: "2026-1042", variableSymbol: "20261042", issueDate: "2026-10-01", taxPointDate: "2026-10-01" },
    ...{ dueDate: "2026-10-15", base0: 0, base12: 0, vat12: 0, base21: 2148050, vat21: 451091, total: 2599141 },
    ...{ currency: "CZK", rate: 10_000, text: "Řezivo smrk 30 mm", note: "TAXY doc_b0e22b273a", partnerId: 1 },
  };
  const linked = { invoice: plan.invoice, partnerId: 1 };
  assert.deepEqual(verifyRecord(record, company1.partners, linked, known), []);
  assert.deepEqual(verifyRecord({ ...record, partnerId: 7 }, company1.partners, linked, known), [
    "supplier: Kaktus partner 7, expected partner 1",
  ]);
  assert.deepEqual(verifyRecord(record, company1.partners, { ...linked, partnerId: null }, known), [
    "supplier: Kaktus partner 1, expected a new partner for 90100018",
  ]);
});

function edit(company: Book, number: string, patch: object): Book {
  return {
    ...company,
    invoices: company.invoices.map((record) => (record.number === number ? { ...record, ...patch } : record)),
  };
}

function summary(match: ReturnType<typeof findInBook>): [string, string | null, string[]] {
  switch (match.kind) {
    case "none":
      return ["none", null, []];
    case "duplicate":
      return ["duplicate", match.records[0]!.number, []];
    case "deleted":
      return ["deleted", match.record.number, []];
    default:
      return [match.kind, match.record.number, match.differences];
  }
}
