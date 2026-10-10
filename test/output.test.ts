import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { readKaktus } from "../src/read.js";
import { loadClients } from "../src/taxy/input.js";
import { writeKaktus } from "../src/write/write.js";
import { DATA_DIR, kaktusSetup, ROOT } from "./helpers.js";
import { CLIENTS_PATH, DOCUMENTS } from "./taxy.js";

// The committed run outputs (deliverable 3) must be exactly what the current code produces.

const committed = async (name: string) => JSON.parse(await readFile(join(ROOT, "output", name), "utf8"));

test("output/read.json is what read produces from kaktus/DATA", async () => {
  const expected = await committed("read.json");
  assert.deepEqual({ ...(await readKaktus(DATA_DIR)), vytvoreno: expected.vytvoreno }, expected);
});

test("output/write-report*.json are what write produces on the task data, run twice", async () => {
  const clients = await loadClients(CLIENTS_PATH);
  const { options } = await kaktusSetup();
  for (const name of ["write-report.json", "write-report-rerun.json"]) {
    const expected = await committed(name);
    assert.deepEqual({ ...(await writeKaktus(DOCUMENTS, clients, options)), vytvoreno: expected.vytvoreno }, expected);
  }
});
