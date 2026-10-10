import assert from "node:assert/strict";
import { test } from "node:test";
import { fitText, isStorable } from "../src/kaktus/text.js";

test("text is storable only if both Windows-1250 and CP852 can hold it", () => {
  assert.equal(isStorable("Příliš žluťoučký kůň úpěl ďábelské ódy"), true);
  for (const text of ["€", "„", "–", "…", "→", "😀"]) assert.equal(isStorable(text), false, text);
});

test("free text is transliterated and cut to the field length", () => {
  assert.deepEqual(fitText("Krov - díl A → montáž 10/2026", 50), {
    value: "Krov - díl A -> montáž 10/2026",
    transliterated: true,
    truncated: false,
  });
  assert.equal(fitText("„Cena“ 5 € – ok…\tdone ™ 😀", 50).value, '"Cena" 5 EUR - ok... done TM ?');
  assert.deepEqual(fitText("Výroba a montáž dřevěných konstrukcí Hořovice, výrobní družstvo", 40), {
    value: "Výroba a montáž dřevěných konstrukcí Hoř",
    transliterated: false,
    truncated: true,
  });
  assert.equal(fitText("Ends with space at the limit ", 28).value, "Ends with space at the limit");
});

test("control characters become spaces; text may end up empty", () => {
  assert.deepEqual(fitText("A\r\nB\u0000C", 50), { value: "A  B C", transliterated: true, truncated: false });
  assert.deepEqual(fitText(" \t ", 50), { value: "", transliterated: true, truncated: false });
  assert.deepEqual(fitText("ab", 1), { value: "a", transliterated: false, truncated: true });
});
