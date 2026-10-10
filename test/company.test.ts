import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { openedBy } from "../src/kaktus/company.js";
import { kaktusCopy } from "./helpers.js";

test("FIRMA.LCK tells who has the company open; an unreadable one still means open", async () => {
  const companyDir = join(await kaktusCopy(), "DATA", "0001");
  assert.equal(await openedBy(companyDir), null);
  await writeFile(join(companyDir, "FIRMA.LCK"), "uživatel JANA, stanice UCETNI-PC2\r\n");
  assert.equal(await openedBy(companyDir), "uživatel JANA, stanice UCETNI-PC2");
  await writeFile(join(companyDir, "FIRMA.LCK"), "");
  assert.equal(await openedBy(companyDir), "unknown user");

  const heldOpen = join(await kaktusCopy(), "DATA", "0001");
  await mkdir(join(heldOpen, "FIRMA.LCK")); // reading fails, as for a file Kaktus keeps open on Windows
  assert.match((await openedBy(heldOpen)) ?? "", /^unknown user, FIRMA\.LCK not readable: EISDIR$/);
});
