/**
 * Drives the toolbar's assignee filter end to end. `pieces.test.ts` proves
 * `matchesAssignee` classifies items; this proves the select actually narrows
 * the backlog, the board and the agenda, offers "Unassigned", and lets go when
 * set back to "Any assignee".
 *
 * Items are written through the core, not taken from the seed, so the check does
 * not depend on who the seed happens to assign things to. The app's watcher
 * picks them up the way it picks up an MCP write.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { Vault } from "todo-vault";
import { todayIso } from "todo-vault/recurrence";

import { launchHarness, type Harness } from "./harness.mjs";
import { eventually, itemRow } from "./drive.mjs";

describe("The assignee filter narrows every view that has one", { concurrency: 1 }, () => {
  let harness: Harness;
  let adaKey: string;
  let graceKey: string;
  let nobodyKey: string;

  const select = () => harness.page.locator("select[title='Who will do the work']");

  before(async () => {
    harness = await launchHarness();
    await harness.page.locator("table.table tbody tr").first().waitFor({ state: "visible" });

    const vault = await Vault.open(harness.vaultRoot);
    const today = todayIso();
    adaKey = (
      await vault.createItem({ project: "ACME", summary: "Ada's filter task", assignee: "Ada Lovelace", dueDate: today })
    ).key;
    graceKey = (
      await vault.createItem({ project: "ACME", summary: "Grace's filter task", assignee: "Grace Hopper", dueDate: today })
    ).key;
    nobodyKey = (
      await vault.createItem({ project: "ACME", summary: "Nobody's filter task", dueDate: today })
    ).key;

    for (const key of [adaKey, graceKey, nobodyKey]) {
      await itemRow(harness.page, key).waitFor({ state: "visible" });
    }
  });

  after(async () => {
    await harness.close();
  });

  test("a named assignee keeps only that person's work in the backlog", async () => {
    await select().selectOption({ label: "Ada Lovelace" });
    await eventually(
      "only Ada's task is listed",
      async () => [
        await itemRow(harness.page, adaKey).count(),
        await itemRow(harness.page, graceKey).count(),
        await itemRow(harness.page, nobodyKey).count(),
      ],
      ([ada, grace, nobody]) => ada === 1 && grace === 0 && nobody === 0,
    );
  });

  test("Unassigned keeps only the work nobody has picked up", async () => {
    await select().selectOption({ label: "Unassigned" });
    await eventually(
      "only the unassigned task is listed",
      async () => [
        await itemRow(harness.page, adaKey).count(),
        await itemRow(harness.page, graceKey).count(),
        await itemRow(harness.page, nobodyKey).count(),
      ],
      ([ada, grace, nobody]) => ada === 0 && grace === 0 && nobody === 1,
    );
  });

  test("the board honours it too", async () => {
    await select().selectOption({ label: "Grace Hopper" });
    await harness.page.getByRole("tab", { name: "Board" }).click();
    await harness.page.locator(".column").first().waitFor({ state: "visible" });
    const card = (summary: string) => harness.page.locator(".card", { hasText: summary });
    await eventually(
      "only Grace's card is on the board",
      async () => [
        await card("Ada's filter task").count(),
        await card("Grace's filter task").count(),
        await card("Nobody's filter task").count(),
      ],
      ([ada, grace, nobody]) => ada === 0 && grace === 1 && nobody === 0,
    );
  });

  test("the agenda has the control and honours it", async () => {
    await harness.page.getByRole("tab", { name: "Agenda" }).click();
    await select().waitFor({ state: "visible" });
    await select().selectOption({ label: "Ada Lovelace" });
    const row = (key: string) => harness.page.locator(".agenda .row", { has: harness.page.locator(`.cell-key:text-is("${key}")`) });
    await eventually(
      "only Ada's task is on the agenda",
      async () => [await row(adaKey).count(), await row(graceKey).count(), await row(nobodyKey).count()],
      ([ada, grace, nobody]) => ada >= 1 && grace === 0 && nobody === 0,
    );
  });

  test("History has no assignee control", async () => {
    await harness.page.getByRole("tab", { name: "History" }).click();
    await harness.page.locator("select").first().waitFor({ state: "visible" });
    assert.equal(await select().count(), 0);
  });

  test("setting it back to Any assignee brings everything back", async () => {
    await harness.page.getByRole("tab", { name: "Backlog" }).click();
    await select().selectOption({ label: "Any assignee" });
    await eventually(
      "all three tasks are listed again",
      async () => [
        await itemRow(harness.page, adaKey).count(),
        await itemRow(harness.page, graceKey).count(),
        await itemRow(harness.page, nobodyKey).count(),
      ],
      ([ada, grace, nobody]) => ada === 1 && grace === 1 && nobody === 1,
    );
  });
});
