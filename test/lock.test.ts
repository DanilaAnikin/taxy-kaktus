import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFile, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LOCK_FILE, lockCompany } from "../src/write/lock.js";
import { kaktusCopy, withoutProcessList } from "./helpers.js";

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

test("on this computer a running owner keeps its lock however old it looks; a reused pid does not", async () => {
  const dir = await companyDir();
  const path = join(dir, LOCK_FILE);
  const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const lockedAt = (since: Date) =>
    writeFile(path, JSON.stringify({ pid: owner.pid, host: hostname(), since: since.toISOString(), token: "other" }));
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  try {
    await lockedAt(new Date());
    await utimes(path, twoHoursAgo, twoHoursAgo); // e.g. the clock was moved forward meanwhile
    assert.equal(await lockCompany(dir), null, "running owner");
    assert.ok(await withoutProcessList(() => lockCompany(dir)), "without the process list, the age decides");

    await lockedAt(twoHoursAgo);
    assert.ok(await lockCompany(dir), "the pid belongs to a process started after the lock was taken");
  } finally {
    owner.kill();
  }
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
