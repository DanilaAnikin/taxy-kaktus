import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renameRetrying, writeFileAtomic } from "../src/util/fs.js";

test("an atomic write replaces the file and leaves no temp file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kaktus-fs-"));
  const path = join(dir, "nested", "report.json");
  await writeFileAtomic(path, "first");
  await writeFileAtomic(path, "second");
  assert.equal(await readFile(path, "utf8"), "second");
  assert.deepEqual(await readdir(join(dir, "nested")), ["report.json"]);
});

// A read-only directory makes rename fail with EACCES, as a file briefly held by an antivirus does on Windows.
const cannotDenyAccess = process.platform === "win32" || process.getuid?.() === 0;

test("a rename blocked for a moment is retried", { skip: cannotDenyAccess }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "kaktus-fs-"));
  const target = join(dir, "target");
  await mkdir(target);
  await writeFile(join(dir, "file"), "data");
  await chmod(target, 0o555);
  setTimeout(() => void chmod(target, 0o755), 150);
  await renameRetrying(join(dir, "file"), join(target, "file"));
  assert.equal(await readFile(join(target, "file"), "utf8"), "data");

  await writeFile(join(dir, "file"), "data");
  await chmod(target, 0o555);
  await assert.rejects(renameRetrying(join(dir, "file"), join(target, "other")), { code: "EACCES" });
  await chmod(target, 0o755);
});
