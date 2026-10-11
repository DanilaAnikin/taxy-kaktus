// Runs dist/test/*.test.js on any OS: Node 18 has no globs in --test, and Windows shells do not expand them.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => relative(process.cwd(), join(dir, name)).replaceAll("\\", "/"));
const { status, error } = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
if (error) throw error;
process.exitCode = status ?? 1;
