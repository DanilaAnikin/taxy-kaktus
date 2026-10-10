import assert from "node:assert/strict";
import { test } from "node:test";
import { MONEY_SCALE, parseFixed, RATE_SCALE } from "../src/util/fixed.js";

test("parses decimal strings into scaled integers", () => {
  assert.equal(parseFixed("12426.32", MONEY_SCALE), 1242632);
  assert.equal(parseFixed("  1.5", MONEY_SCALE), 150);
  assert.equal(parseFixed("-1210", MONEY_SCALE), -121000);
  assert.equal(parseFixed("24.7800", RATE_SCALE), 247800);
  assert.equal(parseFixed("   ", MONEY_SCALE), 0);
});

test("rejects anything that is not a plain decimal within scale", () => {
  for (const text of ["1,00", "1.005", "abc", "1 000", "1e3", "."]) {
    assert.throws(() => parseFixed(text, MONEY_SCALE), RangeError, text);
  }
});
