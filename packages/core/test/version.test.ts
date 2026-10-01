import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { VERSION } from "../src/version.js";

const execFileAsync = promisify(execFile);
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { version: string };

test("VERSION is this workspace's package.json version", () => {
  assert.equal(VERSION, pkg.version);
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});

// The CLI checks --version before help, because `vault --version` has no
// command and would otherwise print the usage text instead.
for (const args of [["--version"], ["version"]]) {
  test(`vault ${args.join(" ")} prints the version and nothing else`, async () => {
    const tsx = createRequire(import.meta.url).resolve("tsx/cli");
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const { stdout } = await execFileAsync(process.execPath, [tsx, cli, ...args]);
    assert.equal(stdout, `${pkg.version}\n`);
  });
}
