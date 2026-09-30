/**
 * Turning history on from the banner, end to end, the way someone without git
 * set up would meet it: a vault that is not a repo, on a machine where git has
 * no identity.
 *
 * The core tests in vault.test.ts already cover the order of steps and each
 * outcome. The real window is the only place to check what they cannot: that
 * the button appears where the banner says something is wrong, that the
 * identity form appears only after main has checked, and that the banner goes
 * away because the snapshot says healthy, not because the renderer assumed it.
 *
 * `GIT_CONFIG_GLOBAL` points at an empty file and `GIT_CONFIG_NOSYSTEM` is on,
 * so the app's git sees no identity even on a machine that has one. Without
 * that, this spec would take the no-form path on a developer's machine and
 * the form path on a bare CI runner, and test different things in each place.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, describe, test } from "node:test";

import type { VaultApi } from "../src/shared/api.js";
import { launchHarness, type Harness } from "./harness.mjs";

const execFileAsync = promisify(execFile);

describe("history turns on from a button", { concurrency: 1 }, () => {
  let harness: Harness;
  let configDir: string;

  const git = async (...args: string[]): Promise<string> =>
    (await execFileAsync("git", args, { cwd: harness.vaultRoot })).stdout.trim();

  before(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), "todo-vault-e2e-gitconfig-"));
    const emptyConfig = path.join(configDir, "config");
    await fs.writeFile(emptyConfig, "");
    harness = await launchHarness({
      git: false,
      env: { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1" },
    });
  });

  after(async () => {
    await harness.close();
    await fs.rm(configDir, { recursive: true, force: true });
  });

  const banner = () => harness.page.locator(".banner-info", { hasText: "no undo history" });

  test("a vault with no repo says so, and offers the button", async () => {
    await banner().waitFor({ state: "visible" });
    assert.match(await banner().innerText(), /not a git repository/);
    await banner().getByRole("button", { name: "Turn on history" }).waitFor();
    await harness.page.getByText("history off").waitFor();
  });

  test("with no identity, the click asks for one and has touched nothing yet", async () => {
    await banner().getByRole("button", { name: "Turn on history" }).click();
    await banner().getByLabel("Name for commits").waitFor();

    const has = (name: string) =>
      fs.stat(path.join(harness.vaultRoot, name)).then(() => true, () => false);
    assert.equal(await has(".git"), false, "no repository that could not commit");
    assert.equal(await has(".gitattributes"), false);
  });

  test("name and email turn it on, and the first commit is the proof", async () => {
    await banner().getByLabel("Name for commits").fill("Vault Owner");
    await banner().getByLabel("Email for commits").fill("owner@example.com");
    await banner().getByRole("button", { name: "Turn on history" }).click();

    await banner().waitFor({ state: "detached", timeout: 15_000 });
    await harness.page.getByText("history on").waitFor();

    assert.equal(await git("log", "--format=%s"), "Turn on history");
    assert.equal(await git("config", "--local", "user.name"), "Vault Owner");
    assert.equal(await git("config", "--local", "user.email"), "owner@example.com");
    assert.equal(
      await fs.readFile(path.join(harness.vaultRoot, ".gitattributes"), "utf8"),
      "* text eol=lf\n",
    );
    assert.equal(await git("status", "--porcelain"), "", "everything already there was committed");
  });

  test("and the next ordinary write is committed too", async () => {
    const key = await harness.page.evaluate(async () => {
      // The preload bridge, typed from the contract it implements. Driving the
      // write through IPC rather than the editor keeps this step about the
      // commit, not about which panel field was clicked.
      const vault = (window as unknown as { vault: VaultApi }).vault;
      const snap = await vault.getSnapshot();
      if (!snap.ok || !snap.value) throw new Error("no snapshot");
      const first = snap.value.items[0]!;
      const updated = await vault.updateItem(first.key, { summary: "Committed after setup" });
      if (!updated.ok) throw new Error(updated.message);
      return first.key;
    });
    assert.equal(await git("rev-list", "--count", "HEAD"), "2");
    assert.equal(await git("log", "-1", "--format=%s"), `Update ${key}`);
  });
});
