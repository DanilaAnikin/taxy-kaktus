import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidIco, planDocument } from "../src/write/plan.js";
import { planContext, taxyDocument, writePlan } from "./taxy.js";

test("maps an approved invoice to the Kaktus record", async () => {
  const plan = await writePlan(taxyDocument("doc_b0e22b273a"));
  assert.deepEqual(plan.ref, { id: "doc_b0e22b273a", klientId: 4172, kaktusFirma: "0001", cisloDokladu: "2026-1042" });
  assert.deepEqual(plan.invoice, {
    supplierNumber: "2026-1042",
    variableSymbol: "20261042",
    supplier: {
      name: "Dřevo Šumava a.s.",
      ico: "90100018",
      dic: "CZ90100018",
      street: "Nádražní 210",
      city: "Sušice",
      zip: "34201",
      country: "CZ",
    },
    issueDate: "2026-10-01",
    taxPointDate: "2026-10-01",
    dueDate: "2026-10-15",
    base0: 0,
    base12: 0,
    vat12: 0,
    base21: 2148050,
    vat21: 451091,
    total: 2599141,
    currency: "CZK",
    rate: null,
    text: "Řezivo smrk 30 mm",
    note: "TAXY doc_b0e22b273a",
  });
  assert.deepEqual(plan.warnings, []);
});

test("rejects documents that must not be written, with a reason", async () => {
  const context = await planContext();
  const cases: [string, Record<string, unknown>, string][] = [
    ["doc_d38c9d950c", {}, "UNKNOWN_CLIENT"],
    ["doc_00d80d05f4", {}, "BUYER_MISMATCH"],
    ["doc_340661d8d9", {}, "MISSING_FIELD"],
    ["doc_b0e22b273a", { typ: "faktura_vydana" }, "UNSUPPORTED_TYPE"],
    ["doc_b0e22b273a", { stav: "ke_schvaleni" }, "NOT_APPROVED"],
    ["doc_b0e22b273a", { dodavatel: { ico: "90100019" } }, "INVALID_ICO"],
    ["doc_b0e22b273a", { variabilniSymbol: "VS-1042" }, "INVALID_FIELD"],
    ["doc_b0e22b273a", { cisloDokladu: "2026-1042-0000-0000-01" }, "FIELD_TOO_LONG"],
    ["doc_b0e22b273a", { datumVystaveni: "2026-02-30" }, "INVALID_FIELD"],
    ["doc_b0e22b273a", { rozpisDph: [{ sazba: 15, zaklad: 21480.5, dph: 3222.08 }] }, "UNSUPPORTED_VAT_RATE"],
    ["doc_b0e22b273a", { rozpisDph: [{ sazba: 21, zaklad: 21480.505, dph: 4510.91 }] }, "INVALID_FIELD"],
    ["doc_b0e22b273a", { celkem: 25992 }, "TOTAL_MISMATCH"],
    ["doc_b0e22b273a", { mena: "EUR" }, "MISSING_RATE"],
    ["doc_b0e22b273a", { kurz: 25 }, "INVALID_FIELD"],
    ["doc_b0e22b273a", { dodavatel: null }, "MISSING_FIELD"],
  ];
  for (const [id, patch, code] of cases) {
    const planned = planDocument(taxyDocument(id, patch), context);
    assert.equal(planned.kind, "rejected", `${id} ${JSON.stringify(patch)}`);
    if (planned.kind === "rejected") {
      assert.equal(planned.result.kod, code, `${id} ${JSON.stringify(patch)}: ${planned.result.zprava}`);
    }
  }
});

test("a rejected document still reports what is known about it", async () => {
  const planned = planDocument(taxyDocument("doc_340661d8d9"), await planContext());
  assert.equal(planned.kind, "rejected");
  if (planned.kind === "rejected") {
    assert.deepEqual(
      [
        planned.result.id,
        planned.result.klientId,
        planned.result.kaktusFirma,
        planned.result.stav,
        planned.result.zprava,
      ],
      ["doc_340661d8d9", 4172, "0001", "rejected", "cisloDokladu is missing"],
    );
  }
});

test("rounding to whole crowns goes to Zaklad0; any other difference is rejected", async () => {
  const plan = await writePlan(taxyDocument("doc_dc39d3bb48"));
  assert.deepEqual(
    [plan.invoice.base0, plan.invoice.base21, plan.invoice.vat21, plan.invoice.total],
    [43, 201700, 42357, 244100],
  );
  assert.deepEqual(
    plan.warnings.map((warning) => warning.kod),
    ["ROUNDING"],
  );

  const context = await planContext();
  for (const patch of [{ celkem: 2440.9 }, { celkem: 2441.08 }, { celkem: 2441, mena: "EUR", kurz: 24.3 }]) {
    const planned = planDocument(taxyDocument("doc_dc39d3bb48", patch), context);
    assert.equal(planned.kind === "rejected" && planned.result.kod, "TOTAL_MISMATCH", JSON.stringify(patch));
  }
});

test("free text is adapted to Kaktus and every change is reported", async () => {
  const plan = await writePlan(taxyDocument("doc_fd3f74cd5a"));
  assert.equal(plan.invoice.supplier.name, "Výroba a montáž dřevěných konstrukcí Hoř");
  assert.equal(plan.invoice.text, "Krov - díl A -> montáž 10/2026");
  assert.deepEqual(
    plan.warnings.map((warning) => warning.kod),
    ["TRUNCATED", "TRANSLITERATED"],
  );
});

test("VAT lines are summed per rate", async () => {
  const plan = await writePlan(taxyDocument("doc_86bc621124"));
  const { base0, base12, vat12, base21, vat21, total } = plan.invoice;
  assert.deepEqual(
    { base0, base12, vat12, base21, vat21, total },
    { base0: 4570, base12: 31030, vat12: 3724, base21: 101990, vat21: 21418, total: 162732 },
  );

  const split = await writePlan(
    taxyDocument("doc_86bc621124", {
      rozpisDph: [
        { sazba: 21, zaklad: 1000, dph: 210 },
        { sazba: 21, zaklad: 19.9, dph: 4.18 },
        { sazba: 12, zaklad: 310.3, dph: 37.24 },
        { sazba: 0, zaklad: 45.7, dph: 0 },
      ],
    }),
  );
  assert.deepEqual([split.invoice.base21, split.invoice.vat21], [101990, 21418]);
});

test("foreign currency keeps amounts in the currency with the rate", async () => {
  const plan = await writePlan(taxyDocument("doc_39ad40f7b2"));
  assert.deepEqual(
    [plan.invoice.currency, plan.invoice.rate, plan.invoice.base0, plan.invoice.total],
    ["EUR", 243150, 236000, 236000],
  );
  assert.equal(plan.invoice.supplier.ico, null);
});

test("VAT that does not match the rate is written with a warning", async () => {
  const plan = await writePlan(
    taxyDocument("doc_b0e22b273a", { rozpisDph: [{ sazba: 21, zaklad: 21480.5, dph: 4500 }], celkem: 25980.5 }),
  );
  assert.deepEqual(
    plan.warnings.map((warning) => warning.kod),
    ["VAT_DEVIATION"],
  );
});

test("validates the IČO check digit", () => {
  for (const ico of ["90100018", "00242659", "04512375", "90412761"]) assert.equal(isValidIco(ico), true, ico);
  for (const ico of ["90100019", "9010001", "CZ901000", "1234567a"]) assert.equal(isValidIco(ico), false, ico);
});

test("other invalid documents are rejected with a reason", async () => {
  const context = await planContext();
  const cases: [Record<string, unknown>, string][] = [
    [{ id: "doc 1" }, "INVALID_FIELD"],
    [{ id: undefined }, "MISSING_FIELD"],
    [{ klientId: "4172" }, "INVALID_FIELD"],
    [{ cisloDokladu: "  " }, "MISSING_FIELD"],
    [{ cisloDokladu: "2026\t1042" }, "INVALID_FIELD"],
    [{ cisloDokladu: "2026–1042" }, "INVALID_FIELD"],
    [{ odberatel: null }, "MISSING_FIELD"],
    [{ dodavatel: { nazev: "  " } }, "MISSING_FIELD"],
    [{ dodavatel: { dic: "CZ 90100018" } }, "INVALID_FIELD"],
    [{ dodavatel: { stat: "CZE" } }, "INVALID_FIELD"],
    [{ mena: "czk" }, "INVALID_FIELD"],
    [{ mena: "EUR", kurz: 0 }, "INVALID_FIELD"],
    [{ mena: "EUR", kurz: 24.31555 }, "INVALID_FIELD"],
    [{ rozpisDph: {} }, "INVALID_FIELD"],
    [{ rozpisDph: [{ sazba: "21", zaklad: 21480.5, dph: 4510.91 }] }, "INVALID_FIELD"],
    [{ rozpisDph: [{ sazba: 0, zaklad: 21480.5, dph: 4510.91 }] }, "INVALID_FIELD"],
    [{ rozpisDph: [{ sazba: 0, zaklad: 1e9, dph: 0 }], celkem: 1e9 }, "INVALID_FIELD"],
    [{ celkem: "25991.41" }, "INVALID_FIELD"],
    [{ datumSplatnosti: "15.10.2026" }, "INVALID_FIELD"],
    [{ duzp: "2026-10-1" }, "INVALID_FIELD"],
    [{ datumVystaveni: null }, "MISSING_FIELD"],
  ];
  for (const [patch, code] of cases) {
    const planned = planDocument(taxyDocument("doc_b0e22b273a", patch), context);
    assert.equal(planned.kind === "rejected" && planned.result.kod, code, JSON.stringify(patch));
  }
});

test("a client may write only into its own Kaktus company", async () => {
  const context = await planContext();
  const client = context.clients.get(4172)!;
  const cases: [typeof client, string][] = [
    [{ ...client, kaktusFirma: "0003" }, "UNKNOWN_COMPANY"],
    [{ ...client, kaktusFirma: "0002" }, "CLIENT_COMPANY_MISMATCH"],
    [{ ...client, ico: "90581130" }, "CLIENT_COMPANY_MISMATCH"],
  ];
  for (const [changed, code] of cases) {
    const clients = new Map(context.clients).set(4172, changed);
    const planned = planDocument(taxyDocument("doc_b0e22b273a"), { ...context, clients });
    assert.equal(planned.kind === "rejected" && planned.result.kod, code, JSON.stringify(changed));
  }
});

test("credit notes and documents without optional fields are accepted", async () => {
  const credit = await writePlan(
    taxyDocument("doc_b0e22b273a", {
      rozpisDph: [{ sazba: 21, zaklad: -2017, dph: -423.57 }],
      celkem: -2441,
      duzp: null,
      datumSplatnosti: null,
      variabilniSymbol: null,
      popis: null,
    }),
  );
  const { base0, base21, vat21, total, taxPointDate, dueDate, variableSymbol, text } = credit.invoice;
  assert.deepEqual(
    { base0, base21, vat21, total, taxPointDate, dueDate, variableSymbol, text },
    {
      base0: -43,
      base21: -201700,
      vat21: -42357,
      total: -244100,
      taxPointDate: null,
      dueDate: null,
      variableSymbol: null,
      text: null,
    },
  );
  assert.deepEqual(
    credit.warnings.map((warning) => warning.kod),
    ["ROUNDING"],
  );
});

test("text in decomposed Unicode is composed before it reaches Kaktus", async () => {
  const decomposed = "Řezivo smrk 30 mm".normalize("NFD");
  assert.notEqual(decomposed, "Řezivo smrk 30 mm");
  const plan = await writePlan(
    taxyDocument("doc_b0e22b273a", { popis: decomposed, dodavatel: { nazev: "Dřevo Šumava a.s.".normalize("NFD") } }),
  );
  assert.deepEqual(
    [plan.invoice.text, plan.invoice.supplier.name, plan.warnings],
    ["Řezivo smrk 30 mm", "Dřevo Šumava a.s.", []],
  );
});
