import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { CLI, kaktusSetup } from "./helpers.js";
import { CLIENTS_PATH, DOCUMENTS_PATH } from "./taxy.js";

function cli(...args: string[]) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { code: status, stdout, stderr };
}

async function writeArgs() {
  const { dir } = await kaktusSetup();
  const args = (out: string, documents = DOCUMENTS_PATH) => [
    "write",
    ...["--data", join(dir, "DATA"), "--kaktus", join(dir, "kaktus.cjs"), "--state", join(dir, "state")],
    ...["--clients", CLIENTS_PATH, "--documents", documents, "--out", join(dir, out)],
  ];
  return { dir, args };
}

test("read exports both companies and exits 0", async () => {
  const { dir } = await kaktusSetup();
  const out = join(dir, "read.json");
  const { code, stdout } = cli("read", "--data", join(dir, "DATA"), "--out", out);
  assert.equal(code, 0);
  assert.match(stdout, /^0001 Truhlářství Dvořák s\.r\.o\.: suppliers: 23, received invoices: 44, warnings: 1$/m);
  const { firmy } = JSON.parse(await readFile(out, "utf8"));
  assert.deepEqual(
    firmy.map((company: { kaktusFirma: string }) => company.kaktusFirma),
    ["0001", "0002"],
  );
});

test("read exits 1 when a company cannot be read", async () => {
  const { dir } = await kaktusSetup();
  await writeFile(join(dir, "DATA", "0002", "ADRESAR.DBF"), "");
  const { code, stdout } = cli("read", "--data", join(dir, "DATA"), "--out", join(dir, "read.json"));
  assert.equal(code, 1);
  assert.match(stdout, /^0002 .*: FAILED: .*ADRESAR\.DBF: file too short/m);
});

test("write reports every document; it exits 1 while some must be retried, 0 when all are settled", async () => {
  const { dir, args } = await writeArgs();
  execFileSync(process.execPath, [join(dir, "kaktus.cjs"), "zamknout", "0002"]);
  const open = cli(...args("first.json"));
  assert.equal(open.code, 1);
  assert.match(open.stdout, /doc_e3fc203569  0002  deferred +COMPANY_OPEN/);

  execFileSync(process.execPath, [join(dir, "kaktus.cjs"), "odemknout", "0002"]);
  const closed = cli(...args("second.json"));
  assert.equal(closed.code, 0, closed.stderr);
  assert.match(
    closed.stdout,
    /written: 5, already_exists: 27, rejected: 4, needs_review: 1, deferred: 0, error: 0\nOutput: .*second\.json\n$/,
  );
  const report = JSON.parse(await readFile(join(dir, "second.json"), "utf8"));
  assert.equal(report.doklady.length, 37);
});

test("invalid usage or input exits 2 with a reason", async () => {
  const { dir, args } = await writeArgs();
  await writeFile(join(dir, "broken.json"), "[{");
  const cases: [string[], RegExp][] = [
    [[], /missing command/],
    [["copy"], /unknown command "copy"/],
    [["read", "--verbose"], /Unknown option '--verbose'/],
    [[...args("out.json"), "--timeout", "0"], /--timeout must be a whole number of seconds from 1 to 600/],
    [[...args("out.json"), "--timeout", "601"], /--timeout must be/],
    [args("out.json", join(dir, "missing.json")), /missing\.json: ENOENT/],
    [args("out.json", join(dir, "broken.json")), /broken\.json: .*JSON/],
  ];
  for (const [argv, message] of cases) {
    const { code, stderr } = cli(...argv);
    assert.equal(code, 2, argv.join(" "));
    assert.match(stderr, message);
  }
});
