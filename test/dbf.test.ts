import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { DbfFormatError, parseDbf, readDbf } from "../src/kaktus/dbf.js";
import { DATA_DIR, kaktusCopy } from "./helpers.js";

const firmy = () => readFile(join(DATA_DIR, "FIRMY.DBF"));

test("parses FIRMY.DBF and decodes CP852", async () => {
  const table = parseDbf(await firmy(), "FIRMY.DBF");
  assert.deepEqual(table.fields.map((field) => field.name), ["ID", "NAZEV", "ICO", "DIC", "SLOZKA", "PLATCE"]);
  assert.equal(table.records.length, 2);
  assert.equal(table.records[0]?.values.get("NAZEV")?.trim(), "Truhlářství Dvořák s.r.o.");
});

test("rejects structurally broken files", async () => {
  const valid = await firmy();
  const broken: Record<string, Buffer> = {
    empty: Buffer.alloc(0),
    "missing last record": valid.subarray(0, valid.length - 75),
    "extra bytes": Buffer.concat([valid, Buffer.from("xx")]),
    "unknown language driver": patch(valid, 29, 0x99),
    "unsupported version": patch(valid, 0, 0x83),
    "invalid deletion flag": patch(valid, valid.readUInt16LE(8), 0x41),
  };
  for (const [name, bytes] of Object.entries(broken)) {
    assert.throws(() => parseDbf(bytes, name), DbfFormatError, name);
  }
});

test("retries a file that is being rewritten", async () => {
  const path = join(await kaktusCopy(), "DATA", "FIRMY.DBF");
  const valid = await readFile(path);
  await writeFile(path, Buffer.alloc(0));
  setTimeout(() => void writeFile(path, valid), 50);
  const table = await readDbf(path, (parsed) => parsed, { attempts: 5, retryDelayMs: 40 });
  assert.equal(table.records.length, 2);
});

function patch(bytes: Buffer, offset: number, value: number): Buffer {
  const copy = Buffer.from(bytes);
  copy[offset] = value;
  return copy;
}
