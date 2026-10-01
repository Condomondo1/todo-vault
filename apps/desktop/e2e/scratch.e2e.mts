/**
 * The scratch pad's sidebar section and page, driven end to end against the
 * built app and a throwaway seeded vault (which ships with a few notes).
 *
 * Two layers, as in the other specs: the DOM says what the app drew, the vault
 * folder says what it did. A note exists when its file does, so the checks that
 * add, remove or restore one read `scratch/` and `.trash/scratch/` back.
 *
 * One app, one vault, ordered subtests (`{ concurrency: 1 }`).
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import type { Page } from "playwright-core";
import { Vault } from "todo-vault";

import { launchHarness, type Harness } from "./harness.mjs";
import { eventually, findItemKey, itemRow } from "./drive.mjs";

const SIDEBAR_NOTES = 5;

describe("the scratch pad, driven end to end", { concurrency: 1 }, () => {
  let harness: Harness;
  let page: Page;
  let seeded: number;

  const section = () => page.locator("section.sb-scratch");
  const rows = () => section().locator(".scratch-row");
  const cards = () => page.locator(".scratch-card");
  const box = () => page.locator(".capture textarea");
  const sidebarBox = () => section().locator(".sb-add textarea");
  const toast = () => page.locator(".toast");
  const noteFiles = async (): Promise<string[]> =>
    (await fs.readdir(path.join(harness.vaultRoot, "scratch"))).filter((f) => f.endsWith(".md"));
  const trashedFiles = async (): Promise<string[]> => {
    try {
      return await fs.readdir(path.join(harness.vaultRoot, ".trash", "scratch"));
    } catch {
      return [];
    }
  };
  const countLabel = () => section().locator(".sidebar-head .project-count");

  before(async () => {
    harness = await launchHarness();
    page = harness.page;
    await page.locator("table.table tbody tr").first().waitFor({ state: "visible" });
    seeded = (await (await Vault.open(harness.vaultRoot)).listScratch()).notes.length;
    assert.ok(seeded >= 1, "the seed is expected to ship with notes");
  });

  after(async () => {
    await harness.close();
  });

  test("the title row names the app and its version", async () => {
    const version = JSON.parse(
      await fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    assert.equal(await page.locator(".app-title .app-name").innerText(), "ToDo Vault");
    await eventually(
      "the version to arrive over IPC",
      () => page.locator(".app-title .app-version").innerText().catch(() => ""),
      (text) => text === `v${version.version}`,
    );
  });

  test("the section lists the newest notes with a count, on the Backlog", async () => {
    await countLabel().waitFor({ state: "visible" });
    assert.equal(await countLabel().innerText(), `${seeded} ${seeded === 1 ? "note" : "notes"}`);
    assert.equal(await rows().count(), Math.min(seeded, SIDEBAR_NOTES));
    assert.equal(await section().locator(".sb-more").isVisible(), true);
  });

  test("a note written from outside the app shows up, newest first, with no click", async () => {
    // What Claude's MCP add does: another process, through the core.
    const outside = await Vault.open(harness.vaultRoot);
    await outside.addScratch("Written from outside the app");

    await eventually(
      "the section to pick the note up",
      () => rows().first().innerText().catch(() => ""),
      (text) => text.includes("Written from outside the app"),
    );
    assert.equal(await countLabel().innerText(), `${seeded + 1} notes`);
    seeded += 1;
  });

  test("quick-add: + new opens a box that keeps going, and bare keys typed in it are text", async () => {
    await section().locator(".add-btn").click();
    await sidebarBox().waitFor({ state: "visible" });
    assert.equal(await sidebarBox().evaluate((el) => el === document.activeElement), true);

    // "n" would open the New item dialog and "x" would trash a selection if the
    // box let its keys through to the window handler.
    await sidebarBox().pressSequentially("n x j quick one");
    await page.keyboard.press("Enter");

    await eventually(
      "the note to reach disk",
      async () => (await (await Vault.open(harness.vaultRoot)).listScratch()).notes.map((n) => n.text),
      (texts) => texts.includes("n x j quick one"),
    );
    assert.equal(await page.locator("form.modal").count(), 0, "no dialog opened while typing in the box");
    // Emptied once main has answered, which is just after the file lands.
    await eventually("the box to empty for the next note", () => sidebarBox().inputValue(), (value) => value === "");
    assert.equal(await sidebarBox().isVisible(), true, "and stays open");
    assert.match(await toast().innerText(), /Added to scratch/);

    await page.keyboard.press("Escape");
    await sidebarBox().waitFor({ state: "detached" });
    seeded += 1;
  });

  test("Shift+N opens the same box from any view", async () => {
    await page.locator("body").click({ position: { x: 600, y: 300 } });
    await page.keyboard.press("Shift+N");

    await sidebarBox().waitFor({ state: "visible" });
    assert.equal(await sidebarBox().evaluate((el) => el === document.activeElement), true);

    // Ctrl-K is the one shortcut that works while typing, so it must still reach
    // the window from inside the box.
    await page.keyboard.press("Control+K");
    await page.locator(".palette-input").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.locator(".palette-input").waitFor({ state: "detached" });

    await sidebarBox().focus();
    await page.keyboard.press("Escape");
    await sidebarBox().waitFor({ state: "detached" });
  });

  test("More… opens the page: no tab is selected and the capture box has focus", async () => {
    await section().locator(".sb-more").click();
    await page.locator(".scratch-page").waitFor({ state: "visible" });

    assert.equal(await page.locator('[role="tab"][aria-selected="true"]').count(), 0);
    assert.equal(await box().evaluate((el) => el === document.activeElement), true);
    assert.equal(await cards().count(), seeded);
    assert.equal(await page.locator("input[type=search]").count(), 0, "the filter row is hidden here");
  });

  test("Ctrl-K opens the search from inside the capture box", async () => {
    assert.equal(await box().evaluate((el) => el === document.activeElement), true);

    await page.keyboard.press("Control+K");
    await page.locator(".palette-input").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.locator(".palette-input").waitFor({ state: "detached" });

    await box().focus();
  });

  test("/ does nothing on Scratch, and Escape leaves the box without refocusing it", async () => {
    await page.keyboard.press("Escape");
    assert.equal(await box().evaluate((el) => el === document.activeElement), false);

    await page.keyboard.press("/");
    assert.equal(await page.locator("input[type=search]").count(), 0);
    assert.equal(await page.locator("form.modal").count(), 0);
  });

  test("j and k move through the notes and x removes the selected one, with Undo", async () => {
    // Escape from the box selected the first note; j moves to the second.
    await page.keyboard.press("j");
    const second = cards().nth(1);
    assert.equal(await second.getAttribute("aria-selected"), "true");
    const id = (await second.getAttribute("data-note-id")) as string;

    await page.keyboard.press("k");
    assert.equal(await cards().first().getAttribute("aria-selected"), "true");
    await page.keyboard.press("j");

    await page.keyboard.press("x");
    await eventually("the note to leave scratch/", noteFiles, (files) => !files.includes(`${id}.md`));
    assert.ok((await trashedFiles()).some((f) => f.startsWith(id)), "and land in .trash/scratch");
    await eventually("the card to leave the page", () => cards().count(), (n) => n === seeded - 1);
    // The earlier "Added to scratch" notice can still be up for a moment; the
    // undo toast takes its slot once main has answered.
    await toast().getByRole("button", { name: "Undo" }).waitFor({ state: "visible" });
    assert.match(await toast().innerText(), /Trashed a scratch note/);

    // The selection moved to the neighbour rather than vanishing, so x keeps working.
    assert.equal(await page.locator('.scratch-card[aria-selected="true"]').count(), 1);

    await toast().getByRole("button", { name: "Undo" }).click();
    await eventually("the note to come back", noteFiles, (files) => files.includes(`${id}.md`));
    await eventually("the card to return", () => cards().count(), (n) => n === seeded);
  });

  test("a project click leaves the page for Backlog, and no project is current on it", async () => {
    assert.equal(await page.locator(".sidebar .sidebar-scroll .project[aria-current='true']").count(), 0);

    await page.locator(".sidebar-scroll .project", { hasText: "All projects" }).click();
    await page.locator(".scratch-page").waitFor({ state: "detached" });
    await page.locator("table.table tbody tr").first().waitFor({ state: "visible" });
  });

  test("x on Scratch never trashes the item that was selected before", async () => {
    const key = await findItemKey(harness.vaultRoot, "Agree the target reporting schema");
    await itemRow(page, key).click();
    await page.locator("aside.detail").waitFor({ state: "visible" });

    // 6 is the Scratch page; the detail panel and the item selection stay behind.
    await page.keyboard.press("6");
    await page.locator(".scratch-page").waitFor({ state: "visible" });
    assert.equal(await page.locator("aside.detail").count(), 0);

    await page.keyboard.press("Escape"); // out of the box
    await page.keyboard.press("x");

    const vault = await Vault.open(harness.vaultRoot);
    assert.ok(vault.hasItem(key), "the item survived an x pressed on Scratch");
    assert.equal(await cards().count(), seeded, "and no note was removed with nothing selected");
  });

  test("a note row opens the page with that note selected and the box left alone", async () => {
    await page.locator(".sidebar-scroll .project", { hasText: "All projects" }).click();
    await page.locator("table.table tbody tr").first().waitFor({ state: "visible" });

    await rows().nth(1).click();
    await page.locator(".scratch-page").waitFor({ state: "visible" });

    assert.equal(await page.locator('.scratch-card[aria-selected="true"]').count(), 1);
    assert.equal(await box().evaluate((el) => el === document.activeElement), false);
    assert.equal(await rows().nth(1).getAttribute("aria-current"), "true");
  });

  test("the Trash lists a removed note, and Restore brings it back", async () => {
    await page.locator('.scratch-card[aria-selected="true"]').locator(".scratch-x").click();
    await eventually("the trash to hold a note", trashedFiles, (files) => files.length > 0);
    await toast().waitFor({ state: "visible" });
    seeded -= 1;

    await page.keyboard.press("t");
    const panel = page.locator(".modal", { hasText: "Trash" });
    await panel.waitFor({ state: "visible" });
    await panel.locator(".trash-group", { hasText: "Scratch" }).waitFor({ state: "visible" });

    const before = (await noteFiles()).length;
    await panel.locator(".trash-group + .rows .row").first().getByRole("button", { name: "Restore" }).click();
    await eventually("the note to come back", noteFiles, (files) => files.length === before + 1);
    seeded += 1;
    await panel.getByRole("button", { name: "✕" }).click();
    await panel.waitFor({ state: "detached" });
  });

  test("Ctrl-K finds a note and opens it on the page", async () => {
    await page.locator(".sidebar-scroll .project", { hasText: "All projects" }).click();
    await page.keyboard.press("Control+K");
    await page.locator(".palette-input").fill("quick one");

    await page.locator(".palette-group", { hasText: "Scratch" }).waitFor({ state: "visible" });
    await page.keyboard.press("Enter");

    await page.locator(".scratch-page").waitFor({ state: "visible" });
    const selected = page.locator('.scratch-card[aria-selected="true"]');
    assert.equal(await selected.count(), 1);
    assert.match(await selected.innerText(), /quick one/);
  });
});
