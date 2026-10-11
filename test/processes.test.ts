import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { isAlive, listProcesses, stopProcess } from "../src/util/processes.js";
import { withoutProcessList } from "./helpers.js";

test("the process list shows a running process with its start and command line; it can be stopped", async () => {
  const before = Date.now();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "listed-argument"], { stdio: "ignore" });
  try {
    const listed = (await listProcesses()).find((info) => info.pid === child.pid);
    assert.ok(listed?.commandLine.includes("listed-argument"), listed?.commandLine);
    const startedAt = listed?.startedAt ?? Number.NaN;
    // ps prints whole seconds; on Linux it adds them to a boot time in whole seconds, so up to 2 s early
    assert.ok(startedAt >= before - 2000 && startedAt <= Date.now(), `started ${startedAt}, test began ${before}`);

    assert.equal(isAlive(child.pid!), true);
    assert.equal(await stopProcess(child.pid!), true);
    assert.equal(isAlive(child.pid!), false);
  } finally {
    child.kill();
  }
});

test("without ps or PowerShell the process list fails instead of looking empty", async () => {
  await withoutProcessList(() => assert.rejects(listProcesses(), /ENOENT/));
});
