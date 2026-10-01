/**
 * Pasting several lines into a scratch box, end to end: the one question it asks,
 * both answers, Escape and Enter as "keep as one", and the cases that must not
 * ask at all (a fenced block, text where every line is indented, a single line,
 * a very long paste).
 *
 * The paste is real. The text goes onto the system clipboard from the app's main
 * process and Ctrl+V does the rest, because a synthetic paste event is not
 * trusted and would not put the text in the box. That replaces whatever was on
 * the machine's clipboard, so it is read first and written back at the end, as
 * text only: an image or files on it would be lost.
 *
 * Both boxes are covered: the page's capture box and the sidebar's quick-add,
 * which is a textarea so that a multi-line paste is not flattened.
 *
 * One app, one vault, ordered subtests (`{ concurrency: 1 }`).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import type { Page } from "playwright-core";
import { Vault } from "todo-vault";

import { launchHarness, type Harness } from "./harness.mjs";
import { eventually } from "./drive.mjs";

const LINES = ["Call the plumber", "Order printer toner", "Book dentist", "Reply to Priya re: offsite"];

describe("pasting several lines into a scratch box", { concurrency: 1 }, () => {
  let harness: Harness;
  let page: Page;

  const box = () => page.locator(".capture textarea");
  const sidebarBox = () => page.locator("section.sb-scratch .sb-add textarea");
  const prompt = () => page.locator(".paste-prompt");
  const cards = () => page.locator(".scratch-card");
  const noteTexts = async (): Promise<string[]> =>
    (await (await Vault.open(harness.vaultRoot)).listScratch()).notes.map((n) => n.text);

  // The clipboard belongs to the machine, not to this run's --user-data-dir, so
  // the spec saves what was on it and puts it back. Only text is restored: an
  // image or files on the clipboard would still be lost.
  let savedClipboard = "";

  /** Put text on the clipboard and paste it into whatever has focus. */
  async function paste(text: string): Promise<void> {
    await harness.app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
    await page.keyboard.press("Control+V");
  }

  before(async () => {
    harness = await launchHarness();
    page = harness.page;
    savedClipboard = await harness.app.evaluate(({ clipboard }) => clipboard.readText());
    await page.locator("table.table tbody tr").first().waitFor({ state: "visible" });

    const vault = await Vault.open(harness.vaultRoot);
    for (const note of (await vault.listScratch()).notes) await vault.removeScratch(note.id);
    await eventually(
      "the pad to read as empty",
      () => page.locator("section.sb-scratch .sidebar-head .project-count").innerText(),
      (text) => text === "0 notes",
    );
    await page.locator("table.table tbody tr").first().click();
    await page.keyboard.press("6");
    await page.locator(".scratch-page").waitFor({ state: "visible" });
    await box().focus();
  });

  after(async () => {
    await harness.app.evaluate(({ clipboard }, text) => clipboard.writeText(text), savedClipboard).catch(() => undefined);
    await harness.close();
  });

  test("plain lines ask once, and Add as N notes makes one note per line, in pasted order", async () => {
    await paste(`${LINES[0]}\n\n${LINES[1]}\n${LINES[2]}\n${LINES[3]}\n`);

    await prompt().waitFor({ state: "visible" });
    assert.match(await prompt().innerText(), /4 lines pasted/);
    assert.match(await box().inputValue(), /Call the plumber/, "the paste is in the box while it is being asked about");
    assert.deepEqual(await noteTexts(), [], "nothing is added until the question is answered");

    await prompt().getByRole("button", { name: "Add as 4 notes" }).click();

    await eventually("four notes to exist", noteTexts, (texts) => texts.length === 4);
    await eventually("the cards to render", () => cards().count(), (n) => n === 4);
    assert.deepEqual(await noteTexts(), LINES, "newest first, so the list reads in the order pasted");
    // Once the last note is saved, which is just after its card is on screen.
    await eventually("what was pasted to leave the box", () => box().inputValue(), (value) => value === "");
    await prompt().waitFor({ state: "detached" });
  });

  test("Esc keeps the paste as one note without leaving the box, and Enter then adds it", async () => {
    await box().focus();
    await paste("one thing\nanother thing\nand a third");
    await prompt().waitFor({ state: "visible" });

    await page.keyboard.press("Escape");
    await prompt().waitFor({ state: "detached" });
    assert.equal(await box().evaluate((el) => el === document.activeElement), true, "Esc only answered the question");
    assert.match(await box().inputValue(), /another thing/);

    await page.keyboard.press("Enter");
    await eventually(
      "the three lines to be one note",
      noteTexts,
      (texts) => texts.includes("one thing\nanother thing\nand a third"),
    );
    assert.equal((await noteTexts()).length, 5);
    await eventually("the box to empty after the add", () => box().inputValue(), (value) => value === "");
  });

  test("Enter while the question is up means one note too", async () => {
    await box().focus();
    await paste("alpha\nbeta");
    await prompt().waitFor({ state: "visible" });

    await page.keyboard.press("Enter");
    await eventually("the pair to be one note", noteTexts, (texts) => texts.includes("alpha\nbeta"));
    await prompt().waitFor({ state: "detached" });
    await eventually("the box to empty after the add", () => box().inputValue(), (value) => value === "");
  });

  test("Keep as 1 note dismisses the question and leaves the text for Enter", async () => {
    await box().focus();
    await paste("red\ngreen\nblue");
    await prompt().getByRole("button", { name: "Keep as 1 note" }).click();

    await prompt().waitFor({ state: "detached" });
    assert.equal(await box().inputValue(), "red\ngreen\nblue");
    await box().fill("");
  });

  test("a fenced block, an all-indented block, a single line and a long paste do not ask", async () => {
    await box().focus();
    const quiet = [
      "```sql\nSELECT owner FROM tickets;\n```",
      "  retry: 3\n  backoff: exponential\n  max_wait: 30s",
      "\n\njust one thing\n\n",
      Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n"),
    ];
    for (const text of quiet) {
      await box().fill("");
      await paste(text);
      await page.waitForTimeout(250);
      assert.equal(await prompt().count(), 0, `no question for ${JSON.stringify(text.slice(0, 24))}`);
      assert.ok((await box().inputValue()).length > 0, "and the text is in the box");
    }
    await box().fill("");
  });

  test("the sidebar's box asks the same question and keeps what is pasted", async () => {
    // Out of the page's box, and off the page: on it, + new focuses the page's own box.
    await page.keyboard.press("Escape");
    await page.keyboard.press("1");
    await page.locator(".scratch-page").waitFor({ state: "detached" });
    await page.locator("section.sb-scratch .add-btn").click();
    await sidebarBox().waitFor({ state: "visible" });

    await paste("north\nsouth\neast");
    await prompt().waitFor({ state: "visible" });
    assert.match(await prompt().innerText(), /3 lines pasted/);
    assert.equal((await sidebarBox().inputValue()).split("\n").length, 3, "newlines survive in the sidebar box");

    await page.keyboard.press("Escape");
    await prompt().waitFor({ state: "detached" });
    assert.equal(await sidebarBox().isVisible(), true, "Esc answered the question; the box stays open");
    assert.equal(await sidebarBox().evaluate((el) => el === document.activeElement), true);

    await sidebarBox().fill("");
    await paste("north\nsouth\neast");
    await prompt().getByRole("button", { name: "Add as 3 notes" }).click();

    await eventually("three notes to be added", noteTexts, (texts) => ["north", "south", "east"].every((t) => texts.includes(t)));
    await page.locator(".toast").getByText("Added 3 notes to scratch").waitFor({ state: "visible" });
    await eventually("the sidebar box to empty", () => sidebarBox().inputValue(), (value) => value === "");
  });

  test("editing the pasted text away withdraws the question", async () => {
    await sidebarBox().focus();
    await paste("one\ntwo");
    await prompt().waitFor({ state: "visible" });

    await sidebarBox().fill("something else");
    await prompt().waitFor({ state: "detached" });
  });
});
