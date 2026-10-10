import assert from "node:assert/strict";
import { test } from "node:test";
import { formatFixed, MONEY_SCALE, numberToFixed, parseFixed, RATE_SCALE } from "../src/util/fixed.js";

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

test("converts JSON numbers exactly", () => {
  assert.equal(numberToFixed(21480.5, MONEY_SCALE), 2148050);
  assert.equal(numberToFixed(1446.9, MONEY_SCALE), 144690);
  assert.equal(numberToFixed(-0.3, MONEY_SCALE), -30);
  assert.equal(numberToFixed(24.315, RATE_SCALE), 243150);
  assert.throws(() => numberToFixed(1.005, MONEY_SCALE), RangeError);
  assert.throws(() => numberToFixed(1e21, MONEY_SCALE), RangeError);
});

test("formats scaled integers as plain decimals", () => {
  assert.equal(formatFixed(120970, MONEY_SCALE), "1209.70");
  assert.equal(formatFixed(-30, MONEY_SCALE), "-0.30");
  assert.equal(formatFixed(5, MONEY_SCALE), "0.05");
  assert.equal(formatFixed(0, MONEY_SCALE), "0.00");
  assert.equal(formatFixed(243150, RATE_SCALE), "24.3150");
});

test("handles the whole Kaktus amount range and refuses unsafe integers", () => {
  assert.equal(formatFixed(99_999_999_999, MONEY_SCALE), "999999999.99");
  assert.equal(formatFixed(-9_999_999_999, MONEY_SCALE), "-99999999.99");
  assert.equal(parseFixed("999999999.99", MONEY_SCALE), 99_999_999_999);
  assert.throws(() => parseFixed("90071992547409.92", MONEY_SCALE), RangeError);
});
