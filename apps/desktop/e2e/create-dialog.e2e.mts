/**
 * Drives the New item dialog end to end, against the built app and a throwaway
 * seeded vault. Written *before* the dialog's form state was pulled out into a
 * hook, so it is the check that the extraction changed nothing: typecheck
 * cannot tell a broken submit payload, or a parent picker that stopped
 * resetting, from a working one.
 *
 * Two layers, as in `comment-editor.e2e.mts`. The DOM says what the form
 * offered; the file says what Create actually wrote. Only the second is what an
 * item *is*, so the payload checks read the vault back from disk.
 *
 * One app, one vault, ordered subtests (`{ concurrency: 1 }`).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import type { Page } from "playwright-core";
import { Vault } from "todo-vault";

import { launchHarness, type Harness } from "./harness.mjs";
import { eventually, findItemKey, openItem } from "./drive.mjs";

const EPIC = "Migrate reporting off the legacy warehouse";

/** The open dialog. `.modal` is the form, so a locator on it fails loudly if none is open. */
function dialog(page: Page) {
  return page.locator("form.modal");
}

/** A dialog field by its visible label. */
function field(page: Page, label: string) {
  return dialog(page).locator(`label:has(> span:text-is(${JSON.stringify(label)}))`);
}

function createButton(page: Page) {
  return dialog(page).getByRole("button", { name: "Create", exact: true });
}

/**
 * Opens it from the keyboard, as `n` does. The toolbar button is covered by the
 * detail panel once an item is selected, and the first test clicks it anyway.
 */
async function openDialog(page: Page, { button = false } = {}): Promise<void> {
  if (button) await page.getByRole("button", { name: "+ New", exact: true }).click();
  else await page.keyboard.press("n");
  await dialog(page).waitFor({ state: "visible" });
}

async function closeDialog(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await dialog(page).waitFor({ state: "detached" });
}

async function itemsNamed(vaultRoot: string, summary: string) {
  const vault = await Vault.open(vaultRoot);
  return vault.listItems({}).items.filter((item) => item.summary === summary);
}

/** The one item with this summary, once the app's write has reached disk. */
async function created(vaultRoot: string, summary: string) {
  const found = await eventually(
    `the item ${JSON.stringify(summary)} to reach disk`,
    () => itemsNamed(vaultRoot, summary),
    (items) => items.length > 0,
  );
  assert.equal(found.length, 1);
  return found[0];
}

describe("the New item dialog, driven end to end", { concurrency: 1 }, () => {
  let harness: Harness;
  let page: Page;
  let epicKey: string;

  before(async () => {
    harness = await launchHarness();
    page = harness.page;
    await page.locator("table.table tbody tr").first().waitFor({ state: "visible" });
    epicKey = await findItemKey(harness.vaultRoot, EPIC);
  });

  after(async () => {
    await harness.close();
  });

  test("opens as a task with the summary focused and Create off", async () => {
    await openDialog(page, { button: true });

    assert.equal(await field(page, "Type").locator("select").inputValue(), "task");
    assert.ok((await field(page, "Project").locator("select").inputValue()).length > 0);
    assert.equal(
      await field(page, "Summary")
        .locator("input")
        .evaluate((el) => el === document.activeElement),
      true,
    );
    assert.equal(await createButton(page).isDisabled(), true);

    await field(page, "Summary").locator("input").fill("   ");
    assert.equal(await createButton(page).isDisabled(), true, "a blank summary must not enable Create");
  });

  test("Escape closes it without writing anything", async () => {
    await field(page, "Summary").locator("input").fill("Never created");
    await closeDialog(page);

    assert.deepEqual(await itemsNamed(harness.vaultRoot, "Never created"), []);
  });

  test("the parent menu offers only what the hierarchy allows, and resets when the type changes", async () => {
    await openDialog(page);
    await field(page, "Project").locator("select").selectOption("ACME");
    const parent = field(page, "Parent").locator("select");
    const type = field(page, "Type").locator("select");

    // A task hangs off an epic, so the menu is epics only.
    const forTask = await parent.locator("option").allInnerTexts();
    assert.ok(
      forTask.some((text) => text.startsWith(`${epicKey} —`)),
      `expected ${epicKey} among ${JSON.stringify(forTask)}`,
    );
    await parent.selectOption(epicKey);
    assert.equal(await parent.inputValue(), epicKey);

    // A subtask hangs off a story/task/bug, so the epic is no longer legal and
    // the chosen parent is dropped rather than submitted.
    await type.selectOption("subtask");
    assert.equal(await parent.inputValue(), "");
    await field(page, "Summary").locator("input").fill("Has no parent yet");
    assert.equal(await createButton(page).isDisabled(), true, "a subtask with no parent must not be creatable");
    const forSubtask = await parent.locator("option").allInnerTexts();
    assert.ok(
      !forSubtask.some((text) => text.startsWith(`${epicKey} —`)),
      "an epic must not be offered to a subtask",
    );

    // An epic takes no parent at all.
    await type.selectOption("epic");
    assert.equal(await parent.isDisabled(), true);

    await closeDialog(page);
  });

  test("Create writes every field the form carried", async () => {
    await openDialog(page);
    await field(page, "Summary").locator("input").fill("  Check the dialog end to end  ");
    await field(page, "Project").locator("select").selectOption("ACME");
    await field(page, "Type").locator("select").selectOption("bug");
    await field(page, "Priority").locator("select").selectOption("high");
    await field(page, "Parent").locator("select").selectOption(epicKey);
    await field(page, "Due").locator("input").fill("2031-03-04");
    await field(page, "Category").locator("input").fill("  e2e  ");
    await field(page, "Labels").locator("input").fill("alpha, , beta ,");
    await field(page, "Cadence").locator("select").selectOption("weekly");
    await dialog(page).locator(".modal-field:has(> span:text-is('Reporter')) input").fill("Ada");

    const surface = dialog(page).locator("div.description.prose.rich-surface[contenteditable]");
    await surface.click();
    await page.keyboard.type("Typed into the rich editor");

    await createButton(page).click();
    await dialog(page).waitFor({ state: "detached" });

    const item = await created(harness.vaultRoot, "Check the dialog end to end");
    assert.equal(item.project, "ACME");
    assert.equal(item.type, "bug");
    assert.equal(item.priority, "high");
    assert.equal(item.parent, epicKey);
    assert.equal(item.dueDate, "2031-03-04");
    assert.equal(item.category, "e2e");
    assert.deepEqual(item.labels, ["alpha", "beta"]);
    assert.equal(item.cadence, "weekly");
    assert.equal(item.reporter, "Ada");
    assert.equal(item.description.trim(), "Typed into the rich editor");
  });

  test("the app selects what it just created and shows its detail panel", async () => {
    const item = await created(harness.vaultRoot, "Check the dialog end to end");
    await page
      .locator(`aside.detail .detail-head .cell-key:text-is(${JSON.stringify(item.key)})`)
      .waitFor({ state: "visible" });
  });

  test("source mode edits the raw markdown and Create keeps it verbatim", async () => {
    await openDialog(page);
    await field(page, "Summary").locator("input").fill("Source mode note");
    await dialog(page).getByRole("button", { name: "source" }).click();
    await dialog(page).locator("textarea[placeholder^='Markdown']").fill("- one\n- two");
    await createButton(page).click();
    await dialog(page).waitFor({ state: "detached" });

    const item = await created(harness.vaultRoot, "Source mode note");
    assert.equal(item.description.trim(), "- one\n- two");
  });

  test("a child opened from an item arrives typed, parented and in its project", async () => {
    const taskKey = await findItemKey(harness.vaultRoot, "Agree the target reporting schema");
    await openItem(page, taskKey);
    await page
      .locator("aside.detail")
      .getByRole("button", { name: /^\+ new subtask$/ })
      .click();
    await dialog(page).waitFor({ state: "visible" });

    assert.equal(await field(page, "Type").locator("select").inputValue(), "subtask");
    assert.equal(await field(page, "Project").locator("select").inputValue(), "ACME");
    assert.equal(await field(page, "Parent").locator("select").inputValue(), taskKey);

    await field(page, "Summary").locator("input").fill("Child from the panel");
    await createButton(page).click();
    await dialog(page).waitFor({ state: "detached" });

    const item = await created(harness.vaultRoot, "Child from the panel");
    assert.equal(item.type, "subtask");
    assert.equal(item.parent, taskKey);
  });
});
