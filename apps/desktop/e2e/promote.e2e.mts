/**
 * Promoting scratch notes into items from the side panel, end to end: the local
 * prefill, one commit per promote, the next note selected with its form refilled
 * while project, parent and category carry over, Ctrl+Enter from the summary and
 * from the description editor, "Create & keep note", the 255-character summary
 * cut, and a refusal staying in the panel.
 *
 * The seeded notes are cleared and four known ones written through the core, the
 * way an MCP add would arrive, so the order and the text are the test's own.
 *
 * Two layers, as in the other specs: the DOM says what the panel showed, the vault
 * folder says what Create did. An item exists when its file does and a note is
 * gone when its file left `scratch/`, so both are read back from disk.
 *
 * One app, one vault, ordered subtests (`{ concurrency: 1 }`).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, describe, test } from "node:test";

import type { Page } from "playwright-core";
import { Vault } from "todo-vault";

import { launchHarness, type Harness } from "./harness.mjs";
import { eventually, findItemKey } from "./drive.mjs";

const execFileAsync = promisify(execFile);

const BUG_NOTE = "Login page crashes on an empty password";
const TASK_FIRST = "Ask Dana about the vendor questionnaire";
const TASK_REST = "second line of detail";
const TOAST_NOTE = "Order printer toner";
const EPIC = "Migrate reporting off the legacy warehouse";

/** A first line well past the 255-character limit, made of numbered words. */
const LONG_LINE = Array.from({ length: 70 }, (_, i) => `word${i}`).join(" ");

describe("promoting scratch notes, driven end to end", { concurrency: 1 }, () => {
  let harness: Harness;
  let page: Page;
  let epicKey: string;

  const panel = () => page.locator("aside.promote");
  const field = (label: string) => panel().locator(`label:has(> span:text-is(${JSON.stringify(label)}))`);
  const summary = () => field("Summary").locator("input");
  const toast = () => page.locator(".toast");
  const noteFiles = async (): Promise<string[]> =>
    (await fs.readdir(path.join(harness.vaultRoot, "scratch"))).filter((f) => f.endsWith(".md"));
  const itemsNamed = async (text: string) =>
    (await Vault.open(harness.vaultRoot)).listItems({}).items.filter((i) => i.summary === text);
  const created = async (text: string) =>
    (
      await eventually(
        `the item ${JSON.stringify(text.slice(0, 40))} to reach disk`,
        () => itemsNamed(text),
        (items) => items.length > 0,
      )
    )[0];
  const card = (text: string) => page.locator(".scratch-card", { hasText: text });

  before(async () => {
    harness = await launchHarness();
    page = harness.page;
    await page.locator("table.table tbody tr").first().waitFor({ state: "visible" });
    epicKey = await findItemKey(harness.vaultRoot, EPIC);

    const vault = await Vault.open(harness.vaultRoot);
    for (const note of (await vault.listScratch()).notes) await vault.removeScratch(note.id);
    // Oldest first, so the newest — the bug note — heads the list.
    for (const text of [TOAST_NOTE, LONG_LINE, `${TASK_FIRST}\n${TASK_REST}`, BUG_NOTE]) {
      await vault.addScratch(text);
    }

    await eventually(
      "the four notes to reach the sidebar",
      () => page.locator("section.sb-scratch .scratch-row").count(),
      (n) => n === 4,
    );
    await page.locator("section.sb-scratch .sb-more").click();
    await page.locator(".scratch-page").waitFor({ state: "visible" });
  });

  after(async () => {
    await harness.close();
  });

  test("selecting a note opens the panel with a local prefill: summary, a guessed type, nothing sent", async () => {
    assert.equal(await panel().count(), 0, "no panel until a note is selected");
    await card(BUG_NOTE).click();
    await panel().waitFor({ state: "visible" });

    assert.equal(await summary().inputValue(), BUG_NOTE);
    assert.equal(await field("Type").locator("select").inputValue(), "bug", "a strong bug word guesses bug");
    assert.equal((await panel().locator("div.description.prose.rich-surface").innerText()).trim(), "");
    assert.match(await panel().locator(".promote-origin").innerText(), /Login page crashes/);
    assert.equal(await page.locator("aside.detail").count(), 0, "no item panel opens beside it");
  });

  test("Ctrl+Enter from Summary promotes: one commit, the note gone, the next one selected and refilled", async () => {
    await field("Project").locator("select").selectOption("ACME");
    await field("Parent").locator("select").selectOption(epicKey);
    await field("Category").locator("input").fill("triage");

    await summary().focus();
    await page.keyboard.press("Control+Enter");

    const item = await created(BUG_NOTE);
    assert.equal(item.project, "ACME");
    assert.equal(item.type, "bug");
    assert.equal(item.parent, epicKey);
    assert.equal(item.category, "triage");

    // The item file lands before the commit does, so poll for it. The seeded vault
    // has no commits of its own, so until then there is no log to read at all.
    await eventually(
      "the promote commit",
      async () =>
        (await execFileAsync("git", ["log", "-5", "--format=%s"], { cwd: harness.vaultRoot }).catch(() => ({ stdout: "" })))
          .stdout,
      (subjects) => subjects.includes(`Promote scratch note to ${item.key}`),
    );

    await eventually("the note to leave scratch/", async () => noteFiles(), (files) => files.length === 3);
    await toast().getByText(`Created ${item.key}`).waitFor({ state: "visible" });
    assert.equal(await page.locator("aside.detail").count(), 0, "lastCreated did not open the item");

    // The next note is selected and the form refilled from it.
    await eventually("the form to refill from the next note", () => summary().inputValue(), (v) => v === TASK_FIRST);
    assert.equal(await field("Type").locator("select").inputValue(), "task");
    assert.equal(
      (await panel().locator("div.description.prose.rich-surface").innerText()).trim(),
      TASK_REST,
      "the remaining lines become the description",
    );
    assert.equal(await summary().evaluate((el) => el === document.activeElement), true, "focus is back on Summary");
  });

  test("project, parent and category carried over to the next note", async () => {
    assert.equal(await field("Project").locator("select").inputValue(), "ACME");
    assert.equal(await field("Parent").locator("select").inputValue(), epicKey);
    assert.equal(await field("Category").locator("input").inputValue(), "triage");
    assert.equal(await page.locator('.scratch-card[aria-selected="true"]').count(), 1);
  });

  test("Ctrl+Enter works from inside the description editor too", async () => {
    const surface = panel().locator("div.description.prose.rich-surface[contenteditable]");
    await surface.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" and an addition");
    await page.keyboard.press("Control+Enter");

    const item = await created(TASK_FIRST);
    assert.match(item.description, /second line of detail and an addition/);
    await eventually("the next note to be selected", () => summary().inputValue(), (v) => v.startsWith("word0 word1"));
  });

  test("a first line over 255 characters is cut at a word and the rest leads the description", async () => {
    const text = await summary().inputValue();
    assert.ok(text.length <= 255);
    assert.match(text, /word\d+$/, "cut on a whole word");
    await panel().locator(".field-note", { hasText: /longer than 255/ }).waitFor({ state: "visible" });

    const description = (await panel().locator("div.description.prose.rich-surface").innerText()).trim();
    assert.ok(description.startsWith("…word"), `overflow leads the description, saw ${description.slice(0, 30)}`);
  });

  test("Create & keep note makes the item, leaves the note and does not refill the form", async () => {
    const before = await noteFiles();
    const summaryBefore = await summary().inputValue();

    await panel().getByRole("button", { name: "Create & keep note" }).click();

    const item = await created(summaryBefore);
    assert.ok(item.description.trimStart().startsWith("…word"));
    assert.equal(`${item.summary} ${item.description.trim().slice(1)}`, LONG_LINE, "nothing was dropped");
    await toast().getByText(/note kept/).waitFor({ state: "visible" });

    assert.deepEqual(await noteFiles(), before, "the note is still on the pad");
    assert.equal(await summary().inputValue(), summaryBefore, "the form is not reseeded");
    assert.equal(await page.locator('.scratch-card[aria-selected="true"]').count(), 1);
  });

  test("Escape leaves the field, then closes the panel; Enter and p bring it back to Summary", async () => {
    await summary().focus();
    await page.keyboard.press("Escape");
    assert.equal(await summary().evaluate((el) => el === document.activeElement), false);
    assert.equal(await panel().count(), 1, "the first Escape only leaves the field");

    await page.keyboard.press("Escape");
    await panel().waitFor({ state: "detached" });

    await page.keyboard.press("j");
    await panel().waitFor({ state: "visible" });
    assert.equal(await summary().evaluate((el) => el === document.activeElement), false, "j does not steal focus");

    await page.keyboard.press("p");
    await eventually(
      "p to focus Summary",
      () => summary().evaluate((el) => el === document.activeElement),
      (focused) => focused,
    );
  });

  test("a refusal stays in the panel beside the fields and writes nothing", async () => {
    const tooLong = "x".repeat(256);
    const before = (await Vault.open(harness.vaultRoot)).listItems({}).total;
    const notesBefore = await noteFiles();

    await summary().fill(tooLong);
    await panel().getByRole("button", { name: "Create item" }).click();

    await panel().locator(".modal-error").waitFor({ state: "visible" });
    assert.equal((await Vault.open(harness.vaultRoot)).listItems({}).total, before);
    assert.deepEqual(await noteFiles(), notesBefore);
    assert.equal(await summary().inputValue(), tooLong, "what was typed is still there");
  });

  test("fixing it and creating again advances to the next note, and Open goes to the item on Backlog", async () => {
    await summary().fill("Order the toner for the printer");
    await panel().getByRole("button", { name: "Create item" }).click();

    const item = await created("Order the toner for the printer");
    await eventually("the next note's form", () => summary().inputValue(), (v) => v === TOAST_NOTE);

    await toast().getByRole("button", { name: "Open" }).click();
    await page.locator(".scratch-page").waitFor({ state: "detached" });
    await page
      .locator(`aside.detail .detail-head .cell-key:text-is(${JSON.stringify(item.key)})`)
      .waitFor({ state: "visible" });
  });
});
