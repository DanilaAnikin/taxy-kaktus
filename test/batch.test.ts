import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBatch } from "../src/kaktus/batch.js";
import { decode } from "../src/kaktus/encoding.js";
import { taxyDocument, writePlan } from "./taxy.js";

test("builds a Windows-1250 batch with escaped text and fixed-point amounts", async () => {
  const novak = await writePlan(taxyDocument("doc_49aa18c650"));
  const holz = await writePlan(taxyDocument("doc_39ad40f7b2"));
  const bytes = buildBatch("0001", [novak.invoice, holz.invoice]);
  assert.ok(bytes.includes(Buffer.from([0x9a])), "š is 0x9A in Windows-1250 (0xE7 in CP852)");
  const xml = decode(bytes, "cp1250");
  assert.ok(
    xml.startsWith('<?xml version="1.0" encoding="windows-1250"?>\r\n<KaktusDavka verze="3.2" firma="0001">\r\n'),
  );
  for (const line of [
    "      <Nazev>Novák &amp; syn, s.r.o.</Nazev>",
    "    <Text>Broušení nástrojů &lt;září&gt;</Text>",
    "    <Zaklad0>0.00</Zaklad0>",
    "    <Zaklad21>6890.00</Zaklad21>",
    "    <DPH21>1446.90</DPH21>",
    "    <Poznamka>TAXY doc_49aa18c650</Poznamka>",
    "    <Mena>EUR</Mena>",
    "    <Kurz>24.3150</Kurz>",
  ]) {
    assert.ok(xml.includes(`${line}\r\n`), line);
  }
  assert.equal(xml.match(/<FakturaPrijata>/g)?.length, 2);
  assert.equal(xml.match(/<Kurz>/g)?.length, 1, "no rate for CZK");
  assert.equal(xml.match(/<ICO>/g)?.length, 1, "the supplier without IČO has no ICO element");
});

test("refuses empty and oversized batches", async () => {
  const { invoice } = await writePlan(taxyDocument("doc_b0e22b273a"));
  assert.throws(() => buildBatch("0001", []), RangeError);
  assert.throws(
    () =>
      buildBatch(
        "0001",
        Array.from({ length: 21 }, () => invoice),
      ),
    RangeError,
  );
  assert.equal(
    decode(
      buildBatch(
        "0001",
        Array.from({ length: 20 }, () => invoice),
      ),
      "cp1250",
    ).match(/<FakturaPrijata>/g)?.length,
    20,
  );
});

test("empty optional values are left out; text Kaktus cannot store is refused", async () => {
  const { invoice } = await writePlan(
    taxyDocument("doc_8c8a7f4e87", { variabilniSymbol: null, duzp: null, datumSplatnosti: null }),
  );
  const xml = decode(buildBatch("0001", [invoice]), "cp1250");
  for (const element of ["<DIC>", "<VarSymbol>", "<DatumZdanPlneni>", "<DatumSplatnosti>", "<Kurz>"]) {
    assert.ok(!xml.includes(element), element);
  }
  assert.throws(() => buildBatch("0001", [{ ...invoice, text: "5 €" }]), RangeError);
  assert.throws(() => buildBatch("../0001", [invoice]), RangeError);
});
