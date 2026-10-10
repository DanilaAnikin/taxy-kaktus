import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InputError, loadClients, loadDocuments } from "../src/taxy/input.js";
import { CLIENTS_PATH } from "./taxy.js";

async function file(content: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "taxy-input-")), "input.json");
  await writeFile(path, content);
  return path;
}

const client = { klientId: 4172, nazev: "Truhlářství Dvořák s.r.o.", ico: "90412761", kaktusFirma: "0001" };

test("reads the clients of the office", async () => {
  const clients = await loadClients(CLIENTS_PATH);
  assert.deepEqual([...clients.keys()], [4172, 4180]);
  assert.deepEqual(clients.get(4172), client);
  const savedByNotepad = await file(`﻿${JSON.stringify({ klienti: [client] })}`);
  assert.deepEqual(await loadClients(savedByNotepad), new Map([[4172, client]]), "UTF-8 BOM is accepted");
});

test("a malformed clients or documents file stops the run with the reason", async () => {
  const cases: [() => Promise<unknown>, string, RegExp][] = [
    [() => loadClients(join(tmpdir(), "missing-klienti.json")), "UNREADABLE_FILE", /ENOENT/],
    [async () => loadClients(await file("{")), "INVALID_JSON", /input\.json/],
    [async () => loadClients(await file("{}")), "MISSING_FIELD", /klienti is missing/],
    [async () => loadClients(await file('{"klienti": {}}')), "INVALID_FIELD", /klienti must be an array/],
    [
      async () => loadClients(await file(JSON.stringify({ klienti: [client, client] }))),
      "INVALID_FIELD",
      /duplicate klientId 4172/,
    ],
    [
      async () => loadClients(await file(JSON.stringify({ klienti: [{ ...client, ico: 90412761 }] }))),
      "INVALID_FIELD",
      /ico must be a string/,
    ],
    [async () => loadDocuments(await file('{"doklady": []}')), "INVALID_FIELD", /expected an array of documents/],
  ];
  for (const [load, code, message] of cases) {
    await assert.rejects(load, (error: unknown) => {
      assert.ok(error instanceof InputError);
      assert.equal(error.code, code);
      assert.match(error.message, message);
      return true;
    });
  }
});
