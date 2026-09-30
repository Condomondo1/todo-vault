/**
 * A second launch hands over to the first rather than opening a rival window.
 *
 * The second launch is a bare `spawn`, not a second `launchHarness`. The
 * harness waits for a vault table to appear, and the whole point here is that
 * the second copy never draws one. Playwright would also add its own debugging
 * flags, which are not what a double-click on the desktop icon passes.
 *
 * Minimizing first is what makes "focused the existing window" checkable. A
 * window that is already frontmost looks the same whether the handler ran or
 * not. A minimized one only comes back if the handler restored it.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { after, before, describe, test } from "node:test";

import { DESKTOP_ROOT, launchHarness, type Harness } from "./harness.mjs";

const isMinimized = (harness: Harness): Promise<boolean> =>
  harness.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMinimized());

/** Resolves with the exit code, or rejects if the process is still alive after `ms`. */
function exitWithin(child: ReturnType<typeof spawn>, ms: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the second launch was still running after ${ms}ms`));
    }, ms);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe("one launch, one window", { concurrency: 1 }, () => {
  let harness: Harness;

  before(async () => {
    harness = await launchHarness();
  });

  after(async () => {
    await harness.close();
  });

  test("a second launch exits and restores the window already open", async () => {
    await harness.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.minimize());
    // minimize() returns before the OS has done it, so wait until it has.
    for (let i = 0; i < 50 && !(await isMinimized(harness)); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(await isMinimized(harness), true, "precondition: the first window minimized");

    const executablePath = createRequire(import.meta.url)("electron") as unknown as string;
    const second = spawn(executablePath, [DESKTOP_ROOT, `--user-data-dir=${harness.userDataDir}`], {
      cwd: DESKTOP_ROOT,
      stdio: "ignore",
    });

    // Quits cleanly, well under the time it takes to open a vault.
    assert.equal(await exitWithin(second, 15_000), 0);

    // `second-instance` fires in the first copy around the time the second
    // exits, not necessarily before it, so poll rather than read once.
    let restored = false;
    for (let i = 0; i < 50 && !restored; i++) {
      restored = !(await isMinimized(harness));
      if (!restored) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(restored, "the first window came back from minimized");

    // And the first copy is still the one holding the vault.
    await harness.page.locator("table.table tbody tr").first().waitFor({ state: "visible" });
    const windows = await harness.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    assert.equal(windows, 1);
  });
});
