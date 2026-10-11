import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { kaktusProgram, runImport, runningImports } from "../src/kaktus/process.js";

test("the simulator runs on Node with 'import'; KAKTUS.EXE gets /IMPORT as in the manual", () => {
  assert.deepEqual(kaktusProgram("kaktus/kaktus.cjs"), {
    command: process.execPath,
    args: ["kaktus/kaktus.cjs", "import"],
  });
  assert.deepEqual(kaktusProgram("C:\\Kaktus\\KAKTUS.EXE"), { command: "C:\\Kaktus\\KAKTUS.EXE", args: ["/IMPORT"] });
});

test("an import run reports exit code and output, and is killed after the timeout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kaktus-process-"));
  const script = async (name: string, source: string) => {
    await writeFile(join(dir, name), source);
    return kaktusProgram(join(dir, name));
  };

  const args = await script("args.cjs", "console.log(process.argv.slice(2).join(' ')); process.exit(3);");
  const run = await runImport(args, "b.xml", "b.odpoved.xml", 5_000);
  assert.deepEqual(run, { exitCode: 3, signal: null, timedOut: false, output: "import b.xml b.odpoved.xml" });

  const hang = await script("hang.cjs", "setTimeout(() => {}, 60_000);");
  const started = Date.now();
  const killed = await runImport(hang, "b.xml", "b.odpoved.xml", 200);
  assert.equal(killed.timedOut, true);
  assert.ok(Date.now() - started < 5_000);

  await assert.rejects(runImport(kaktusProgram(join(dir, "KAKTUS.EXE")), "b.xml", "b.odpoved.xml", 5_000), /ENOENT/);
});

test("an import run ends when Kaktus exits, even if a helper process keeps its output open", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kaktus-process-"));
  const source = `require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { stdio: "inherit", detached: true }).unref(); console.log("done");`;
  await writeFile(join(dir, "helper.cjs"), source);
  const started = Date.now();
  const run = await runImport(kaktusProgram(join(dir, "helper.cjs")), "b.xml", "b.odpoved.xml", 10_000);
  assert.deepEqual([run.exitCode, run.timedOut, run.output], [0, false, "done"]);
  assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started} ms`);
});

test("a running import is found by the file names of its batch, not by one of them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kaktus-process-"));
  const id = basename(dir); // unique, so no other process on this machine matches
  const files = { batch: join(dir, `${id}.xml`), response: join(dir, `${id}.odpoved.xml`) };
  const hang = (...args: string[]) =>
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...args], { stdio: "ignore" });
  const editor = hang(files.batch);
  const leftover = hang("import", files.batch, files.response);
  try {
    assert.deepEqual(await runningImports(files), [leftover.pid]);
  } finally {
    editor.kill();
    leftover.kill();
  }
});
