/**
 * Editing a scratch note in place, end to end: double-click or `e` swaps a card's
 * Markdown for a box, Ctrl+Enter or leaving the box saves, Escape cancels, and a
 * note that disappears mid-edit keeps its text with a way to save it anew.
 *
 * The vault is a git repository here, and a save is meant to be exactly one
 * "Edit scratch note" commit, so the spec counts them: none for a cancel or an
 * unchanged blur, one per save.
 *
 * One app, one vault, ordered subtests (`{ concurrency: 1 }`).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { after, before, describe, test } from "node:test";

import type { Page } from "playwright-core";
import { Vault } from "todo-vault";

import { launchHarness, type Harness } from "./harness.mjs";
import { eventually } from "./drive.mjs";

const exec = promisify(execFile);

describe("editing a scratch note in place", { concurrency: 1 }, () => {
  let harness: Harness;
  let page: Page;
  const ids: Record<string, string> = {};

  const card = (id: string) => page.locator(`.scratch-card[data-note-id="${id}"]`);
  const editor = () => page.locator(".scratch-edit textarea");
  const textOf = async (id: string): Promise<string | undefined> =>
    (await (await Vault.open(harness.vaultRoot)).listScratch()).notes.find((n) => n.id === id)?.text;
  const edits = async (): Promise<number> => {
    const { stdout } = await exec("git", ["-C", harness.vaultRoot, "log", "--format=%s"]);
    return stdout.split("\n").filter((s) => s === "Edit scratch note").length;
  };

  before(async () => {
    harness = await launchHarness();
    page = harness.page;
    await page.locator("table.table tbody tr").first().waitFor({ state: "visible" });

    const vault = await Vault.open(harness.vaultRoot, { git: true });
    for (const note of (await vault.listScratch()).notes) await vault.removeScratch(note.id);
    // Oldest first, so the list reads first, second, third from the bottom up.
    for (const text of ["third note", "second note", "first note"]) {
      ids[text] = (await vault.addScratch(text)).id;
    }
    await page.keyboard.press("6");
    await page.locator(".scratch-page").waitFor({ state: "visible" });
    await eventually("the three cards", () => page.locator(".scratch-card").count(), (n) => n === 3);
    await page.keyboard.press("Escape"); // out of the capture box
  });

  after(async () => {
    await harness.close();
  });

  test("a double-click opens the note's text, and Ctrl+Enter saves it as one commit", async () => {
    const id = ids["first note"];
    const before = await edits();
    await card(id).dblclick();

    await editor().waitFor({ state: "visible" });
    assert.equal(await editor().evaluate((el) => el === document.activeElement), true);
    assert.equal(await editor().inputValue(), "first note");

    await page.keyboard.type(", **edited**");
    await page.keyboard.press("Control+Enter");

    await editor().waitFor({ state: "detached" });
    assert.equal(await textOf(id), "first note, **edited**");
    await eventually("the card to render the new text", () => card(id).innerText(), (t) => t.includes("edited"));
    assert.equal(await card(id).locator("strong").count(), 1, "back to rendered Markdown");
    assert.equal(await edits(), before + 1);
    assert.equal(await page.locator(".scratch-card").first().getAttribute("data-note-id"), id, "it kept its place");
  });

  test("e edits the selected note, and Escape cancels with no commit and the selection kept", async () => {
    const id = ids["second note"];
    const before = await edits();
    await page.keyboard.press("j"); // the first note is selected from the double-click
    assert.equal(await card(id).getAttribute("aria-selected"), "true");

    await page.keyboard.press("e");
    await editor().waitFor({ state: "visible" });
    assert.equal(await editor().inputValue(), "second note", "the e itself did not land in the box");

    await page.keyboard.type(" that will not stay");
    await page.keyboard.press("Escape");

    await editor().waitFor({ state: "detached" });
    assert.equal(await textOf(id), "second note");
    assert.equal(await edits(), before);
    assert.equal(await card(id).getAttribute("aria-selected"), "true", "App's Escape did not also run");
  });

  test("clicking away saves, and leaving it unchanged makes no commit", async () => {
    const id = ids["second note"];
    let before = await edits();

    await card(id).dblclick();
    await editor().waitFor({ state: "visible" });
    await card(ids["third note"]).click();
    await editor().waitFor({ state: "detached" });
    assert.equal(await edits(), before, "nothing changed, nothing committed");

    await card(id).dblclick();
    await editor().waitFor({ state: "visible" });
    await page.keyboard.type(", saved on blur");
    await card(ids["third note"]).click();

    await eventually("the blur to save", () => textOf(id), (t) => t === "second note, saved on blur");
    await editor().waitFor({ state: "detached" });
    assert.equal(await edits(), (before += 1));
  });

  test("the promote panel follows an edit where it was untouched, and keeps what was typed", async () => {
    const id = ids["first note"];
    const summary = () =>
      page.locator("aside.promote").locator(`label:has(> span:text-is("Summary"))`).locator("input");
    const rewrite = async (text: string): Promise<void> => {
      await card(id).dblclick();
      await editor().waitFor({ state: "visible" });
      await page.keyboard.press("Control+A");
      await page.keyboard.type(text);
      await page.keyboard.press("Control+Enter");
      await editor().waitFor({ state: "detached" });
    };

    await card(id).click();
    await eventually("the panel to fill", () => summary().inputValue(), (v) => v === "first note, **edited**");

    await rewrite("first note, typo fixed");
    await eventually("Summary to follow the fix", () => summary().inputValue(), (v) => v === "first note, typo fixed");

    await summary().fill("My own summary");
    await rewrite("first note, fixed again");
    await eventually("the note to save", () => textOf(id), (t) => t === "first note, fixed again");
    assert.equal(await summary().inputValue(), "My own summary", "typed over, so left alone");
  });

  test("a note removed mid-edit keeps the text, and Save as a new note keeps it", async () => {
    const id = ids["third note"];
    await card(id).dblclick();
    await editor().waitFor({ state: "visible" });
    await page.keyboard.type(", rescued");

    // What Claude promoting it would look like from here: another process.
    await (await Vault.open(harness.vaultRoot, { git: true })).removeScratch(id);

    await page.locator(".scratch-orphan").waitFor({ state: "visible" });
    await card(id).waitFor({ state: "detached" });
    assert.equal(await editor().inputValue(), "third note, rescued");
    assert.match(await page.locator(".scratch-gone").innerText(), /promoted or removed/);

    await page.getByRole("button", { name: "Save as a new note" }).click();
    await page.locator(".scratch-orphan").waitFor({ state: "detached" });
    const texts = (await (await Vault.open(harness.vaultRoot)).listScratch()).notes.map((n) => n.text);
    assert.ok(texts.includes("third note, rescued"));
  });
});
