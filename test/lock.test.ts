import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { LOCK_FILE, lockCompany } from "../src/write/lock.js";
import { kaktusCopy } from "./helpers.js";

const companyDir = async () => join(await kaktusCopy(), "DATA", "0001");

test("a company lock is exclusive until released", async () => {
  const dir = await companyDir();
  const lock = await lockCompany(dir);
  assert.ok(lock);
  assert.equal(await lockCompany(dir), null);
  assert.ok(await lockCompany(join(dir, "..", "0002")), "other companies are independent");
  assert.equal(await lock.renew(), true);
  await lock.release();
  assert.ok(await lockCompany(dir));
});

test("a lock left by a dead process or not renewed for 30 minutes is taken over", async () => {
  const dir = await companyDir();
  const path = join(dir, LOCK_FILE);
  assert.ok(await lockCompany(dir));
  const owner = JSON.parse(await readFile(path, "utf8"));

  const finished = spawnSync(process.execPath, ["-e", ""]);
  await writeFile(path, JSON.stringify({ ...owner, pid: finished.pid }));
  assert.ok(await lockCompany(dir), "dead process");

  await writeFile(path, JSON.stringify({ ...owner, host: "OTHER-PC" }));
  assert.equal(await lockCompany(dir), null, "live lock of another computer");
  const longAgo = new Date(Date.now() - 31 * 60 * 1000);
  await utimes(path, longAgo, longAgo);
  assert.ok(await lockCompany(dir), "not renewed for 30 minutes");

  await writeFile(path, "");
  assert.equal(await lockCompany(dir), null, "a lock file being written");
  const moment = new Date(Date.now() - 11_000);
  await utimes(path, moment, moment);
  assert.ok(await lockCompany(dir), "an unreadable lock file left by a crash");
});

test("a run that lost its lock notices it and does not remove the new owner's lock", async () => {
  const dir = await companyDir();
  const lock = await lockCompany(dir);
  assert.ok(lock);
  const takeover = JSON.stringify({ pid: process.pid, host: "OTHER-PC", token: "other" });
  await writeFile(join(dir, LOCK_FILE), takeover);
  assert.equal(await lock.renew(), false);
  await lock.release();
  assert.equal(await readFile(join(dir, LOCK_FILE), "utf8"), takeover);
});
