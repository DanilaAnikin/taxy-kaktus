import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { loadClients } from "../src/taxy/input.js";
import type { WriteReport } from "../src/write/types.js";
import { writeKaktus } from "../src/write/write.js";
import { kaktusSetup } from "./helpers.js";
import { CLIENTS_PATH, DOCUMENTS, EXPECTED, taxyRecords, WRITTEN_IDS } from "./taxy.js";

/** Rounds from fresh data; `CHAOS_ROUNDS=200 npm test` for a longer session (prints what happened). */
const ROUNDS = Number(process.env.CHAOS_ROUNDS ?? 3);

// The import is not atomic and a kill can leave FAKPRI.DBF empty (findings I4). Here imports are killed at
// random moments around the time one import takes on this machine, and the connector is rerun until every
// document is settled. After every run no document may be in Kaktus twice and the data must be readable;
// at the end every document must be exactly where a clean run puts it.
test("imports killed at random moments never duplicate or lose a document", async () => {
  const clients = await loadClients(CLIENTS_PATH);
  const random = seeded(20261013);
  const importMs = await measureImport();
  const seen = new Map<string, number>();
  const count = (key: string) => seen.set(key, (seen.get(key) ?? 0) + 1);

  for (let round = 0; round < ROUNDS; round++) {
    const { options } = await kaktusSetup();
    let report: WriteReport;
    let run = 0;
    do {
      assert.ok(run++ < 200, `round ${round}: not settled after 200 runs`);
      count("runs");
      const timeoutMs = Math.round(importMs * (0.3 + random()));
      report = await writeKaktus(DOCUMENTS, clients, { ...options, timeoutMs });
      report.udalosti.forEach((event) => count(event.kod));
      report.doklady.forEach((document) => document.varovani.forEach((warning) => count(warning.kod)));
      for (const document of report.doklady) {
        if (document.stav === "needs_review") assert.equal(document.kod, "DELETED_IN_KAKTUS", document.zprava ?? "");
        if (document.stav === "error" || document.stav === "deferred") count(`${document.stav} ${document.kod}`);
      }
      for (const [id, numbers] of await taxyRecords(options.dataDir)) {
        assert.equal(numbers.length, 1, `round ${round}, run ${run}: ${id} written as ${numbers.join(", ")}`);
      }
    } while (report.souhrn.error + report.souhrn.deferred > 0);

    for (const document of report.doklady) {
      const expected = EXPECTED[String(document.id)];
      const actual = document.kod ? `${document.stav} ${document.kod}` : document.stav;
      assert.ok(actual === expected || (expected === "written" && actual === "already_exists"), `${actual}`);
    }
    assert.deepEqual([...(await taxyRecords(options.dataDir)).keys()].sort(), [...WRITTEN_IDS].sort());
  }
  if (process.env.CHAOS_ROUNDS) console.log(Object.fromEntries([...seen].sort()));
});

/** Time one simulator run takes here (Node start included; ~40 ms on a recent Mac, more on Windows). */
async function measureImport(): Promise<number> {
  const { dir } = await kaktusSetup();
  const started = Date.now();
  for (let run = 0; run < 3; run++) spawnSync(process.execPath, [join(dir, "kaktus.cjs"), "obnovit"]);
  return Math.max(20, (Date.now() - started) / 3);
}

/** Deterministic pseudo-random numbers (mulberry32), so a failing sequence can be replayed. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
