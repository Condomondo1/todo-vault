/**
 * Drives the toolbar's "Hide later" end to end. `later.test.ts` proves
 * `isLater` classifies items correctly; this proves the checkbox actually
 * narrows the backlog and board, brings the items back when unticked, and is
 * absent from the calendar, where future starts are the point.
 *
 * The two items under test are written through the core rather than taken
 * from the seed, so the check does not depend on which seeded items happen to
 * be `todo` with a future start or ticked today. The app's watcher picks them
 * up the same way it picks up an MCP write.
 *
 * One app, one vault, ordered subtests (`{ concurrency: 1 }`), following
 * `board-hides-columns.e2e.mts`'s shape.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { Vault } from "todo-vault";
import { addDays, todayIso } from "todo-vault/recurrence";

import { launchHarness, type Harness } from "./harness.mjs";
import { eventually, itemRow } from "./drive.mjs";

describe("Hide later drops work that is not for today", { concurrency: 1 }, () => {
  let harness: Harness;
  let futureKey: string;
  let tickedKey: string;
  let plainKey: string;

  before(async () => {
    harness = await launchHarness();
    await harness.page.locator("table.table tbody tr").first().waitFor({ state: "visible" });

    const vault = await Vault.open(harness.vaultRoot);
    const today = todayIso();
    futureKey = (
      await vault.createItem({
        project: "ACME",
        summary: "Starts next month",
        startDate: addDays(today, 30),
      })
    ).key;
    const daily = await vault.createItem({ project: "ACME", summary: "Daily, done today", cadence: "daily" });
    await vault.tickItem(daily.key, today);
    tickedKey = daily.key;
    plainKey = (await vault.createItem({ project: "ACME", summary: "Actionable now" })).key;

    for (const key of [futureKey, tickedKey, plainKey]) {
      await itemRow(harness.page, key).waitFor({ state: "visible" });
    }
  });

  after(async () => {
    await harness.close();
  });

  test("off by default: later work is listed in the backlog", async () => {
    const box = harness.page.getByRole("checkbox", { name: "Hide later" });
    assert.equal(await box.isChecked(), false);
    for (const key of [futureKey, tickedKey, plainKey]) {
      assert.equal(await itemRow(harness.page, key).count(), 1, `${key} should be listed`);
    }
  });

  test("ticking it hides the future start and the ticked daily, and keeps the rest", async () => {
    await harness.page.getByRole("checkbox", { name: "Hide later" }).click();
    await eventually(
      "the future start and the ticked daily leave the backlog",
      async () => [await itemRow(harness.page, futureKey).count(), await itemRow(harness.page, tickedKey).count()],
      ([future, ticked]) => future === 0 && ticked === 0,
    );
    assert.equal(await itemRow(harness.page, plainKey).count(), 1);
  });

  test("the board honours it too", async () => {
    await harness.page.getByRole("tab", { name: "Board" }).click();
    await harness.page.locator(".column").first().waitFor({ state: "visible" });
    const card = (summary: string) => harness.page.locator(".card", { hasText: summary });
    assert.equal(await card("Starts next month").count(), 0);
    assert.equal(await card("Daily, done today").count(), 0);
    assert.equal(await card("Actionable now").count(), 1);
  });

  test("the calendar has no Hide later control", async () => {
    await harness.page.getByRole("tab", { name: "Calendar" }).click();
    await harness.page.locator(".cal-toolbar").waitFor({ state: "visible" });
    assert.equal(await harness.page.getByRole("checkbox", { name: "Hide later" }).count(), 0);
  });

  test("unticking it brings both back", async () => {
    await harness.page.getByRole("tab", { name: "Backlog" }).click();
    await harness.page.getByRole("checkbox", { name: "Hide later" }).click();
    await eventually(
      "both come back once Hide later is unticked",
      async () => [await itemRow(harness.page, futureKey).count(), await itemRow(harness.page, tickedKey).count()],
      ([future, ticked]) => future === 1 && ticked === 1,
    );
  });
});
