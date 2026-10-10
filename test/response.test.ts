import assert from "node:assert/strict";
import { test } from "node:test";
import { encode } from "../src/kaktus/encoding.js";
import { parseResponse, ResponseFormatError } from "../src/kaktus/response.js";

const VALID = [
  '<?xml version="1.0" encoding="windows-1250"?>',
  '<KaktusOdpoved firma="0001" zapsano="1" odmitnuto="1">',
  '  <Doklad poradi="1" stav="OK" doklad="FP260047"/>',
  '  <Doklad poradi="2" stav="CHYBA" kod="E220" zprava="Datum &quot;DUZP&quot; je mimo období &amp; rok 2026"/>',
  "</KaktusOdpoved>",
].join("\r\n");

const bytes = (text: string) => encode(text, "cp1250");

test("parses the import response", () => {
  assert.deepEqual(parseResponse(bytes(VALID), "0001", 2), [
    { order: 1, ok: true, number: "FP260047" },
    { order: 2, ok: false, code: "E220", message: 'Datum "DUZP" je mimo období & rok 2026' },
  ]);
});

test("rejects anything unexpected instead of guessing", () => {
  const variants: [string, string, string, number][] = [
    ["other company", VALID, "0002", 2],
    ["fewer documents than sent", VALID, "0001", 3],
    ["counts do not match", VALID.replace('zapsano="1"', 'zapsano="2"'), "0001", 2],
    ["wrong order", VALID.replace('poradi="2"', 'poradi="3"'), "0001", 2],
    ["unknown state", VALID.replace('stav="OK"', 'stav="HOTOVO"'), "0001", 2],
    ["unknown attribute", VALID.replace('doklad="FP260047"', 'doklad="FP260047" extra="1"'), "0001", 2],
    ["unknown element", VALID.replace("</KaktusOdpoved>", "<Poznamka/></KaktusOdpoved>"), "0001", 2],
    ["bare ampersand", VALID.replace("&amp; rok", "& rok"), "0001", 2],
    ["truncated", VALID.slice(0, 120), "0001", 2],
    ["empty", "", "0001", 2],
  ];
  for (const [name, text, company, count] of variants) {
    assert.throws(() => parseResponse(bytes(text), company, count), ResponseFormatError, name);
  }
});

test("accepts what XML allows: no declaration, '>' inside a message", () => {
  const text = VALID.replace(/^<\?xml[^>]*\?>\r\n/, "").replace("rok 2026", "rok > 2025");
  assert.equal(parseResponse(bytes(text), "0001", 2)[1]?.ok, false);
  const [, rejected] = parseResponse(bytes(text), "0001", 2);
  assert.equal(rejected?.ok === false && rejected.message, 'Datum "DUZP" je mimo období & rok > 2025');
});
