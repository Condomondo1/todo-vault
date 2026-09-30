/**
 * A click beside the open item closes it, unless something would be lost.
 * Driven on the board, against the built app and a seeded vault.
 *
 * The rules themselves are unit-tested in test/outside-click.test.ts. What
 * only a real window can show is the wiring: that the capture-phase listener
 * runs before a card's own onClick, that the press's focus change is read
 * before it happens, and that "empty space" on a real board is empty.
 *
 * Ordered subtests (`{ concurrency: 1 }`), one app. Each check opens the panel
 * it needs rather than relying on the last one's, except the last, which says
 * so.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import type { Page } from "playwright-core";
import { Vault } from "todo-vault";

import { launchHarness, type Harness } from "./harness.mjs";
import {
  commentEditorSurface,
  commentForm,
  eventually,
  findItemKey,
  readComments,
  stays,
} from "./drive.mjs";

const panel = (page: Page) => page.locator("aside.detail");
const panelKey = (page: Page) => page.locator("aside.detail .detail-head .cell-key");
const card = (page: Page, key: string) => page.locator(`.board [data-item-key="${key}"]`);

async function openCard(page: Page, key: string): Promise<void> {
  await card(page, key).click();
  await eventually("the panel shows the card", () => panelKey(page).innerText(), (text) => text === key);
}

/**
 * A point on the board that is really empty: nothing under it is a control,
 * an item or the panel. Found by asking the page, rather than guessed, so a
 * layout change fails loudly here instead of clicking on a card by accident.
 */
async function emptySpot(page: Page): Promise<{ x: number; y: number }> {
  const spot = await page.evaluate(() => {
    const board = document.querySelector(".board");
    if (!board) return null;
    const box = board.getBoundingClientRect();
    const busy =
      "button, a, input, select, textarea, label, summary, [role], [contenteditable], [data-item-key], aside.detail";
    for (let y = box.bottom - 12; y > box.top + 40; y -= 16) {
      for (let x = box.left + 12; x < box.right - 12; x += 16) {
        const hit = document.elementFromPoint(x, y);
        if (hit && board.contains(hit) && !hit.closest(busy)) return { x, y };
      }
    }
    return null;
  });
  assert.ok(spot, "expected an empty point somewhere on the board");
  return spot!;
}

/**
 * A card other than `except` whose middle is not under the open panel. The
 * panel is fixed to the right and has no backdrop, so on a narrow window it
 * sits on top of whole columns, and a card under it cannot be clicked by
 * anyone, test or person.
 */
async function reachableCard(page: Page, except: string): Promise<string> {
  const key = await page.evaluate((skip) => {
    for (const el of document.querySelectorAll(".board [data-item-key]")) {
      const key = el.getAttribute("data-item-key");
      if (!key || key === skip) continue;
      const box = el.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      if (hit && el.contains(hit)) return key;
    }
    return null;
  }, except);
  assert.ok(key, "expected a card the open panel does not cover");
  return key!;
}

async function clickEmpty(page: Page): Promise<void> {
  const { x, y } = await emptySpot(page);
  await page.mouse.click(x, y);
}

describe("clicking beside the open item", { concurrency: 1 }, () => {
  let harness: Harness;
  let first: string;

  before(async () => {
    harness = await launchHarness();
    first = await findItemKey(harness.vaultRoot, "Agree the target reporting schema");
    // Wide enough that the panel leaves most of the board and the toolbar
    // uncovered, the way it is used. The default window is narrower than that.
    await harness.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.unmaximize();
      win.setSize(1600, 1000);
    });
    await harness.page.getByRole("tab", { name: "Board" }).click();
    await card(harness.page, first).waitFor({ state: "visible" });
  });

  after(async () => {
    await harness.close();
  });

  test("a click on empty board closes the panel", async () => {
    await openCard(harness.page, first);
    await clickEmpty(harness.page);
    await panel(harness.page).waitFor({ state: "detached" });
  });

  test("a click on another card switches to it, as before", async () => {
    await openCard(harness.page, first);
    const second = await reachableCard(harness.page, first);
    await card(harness.page, second).click();
    await eventually("the panel switched", () => panelKey(harness.page).innerText(), (t) => t === second);
  });

  test("a field being edited is committed by the first click, and the second closes", async () => {
    await openCard(harness.page, first);
    const renamed = "Agree the target reporting schema, in writing";
    await panel(harness.page).locator("h2.detail-summary button").click();
    await panel(harness.page).locator("h2.detail-summary input").fill(renamed);

    await clickEmpty(harness.page);
    await eventually(
      "the edit reached the file",
      async () => (await Vault.open(harness.vaultRoot)).getItem(first).summary,
      (summary) => summary === renamed,
    );
    // The positive control for this stays() is the close two lines down.
    await stays("the panel after the first click", () => panel(harness.page).count(), 1);

    await clickEmpty(harness.page);
    await panel(harness.page).waitFor({ state: "detached" });
  });

  test("an unsent comment holds the panel against empty space and other cards", async () => {
    await openCard(harness.page, first);
    const commentsBefore = (await readComments(harness.vaultRoot, first)).length;
    await commentEditorSurface(harness.page).click();
    await commentEditorSurface(harness.page).pressSequentially("Half a thought");

    await clickEmpty(harness.page);
    const notice = harness.page.locator(".comment-unsent");
    await notice.waitFor({ state: "visible" });
    assert.equal(await panelKey(harness.page).innerText(), first);

    // The capture listener has to beat the card's own onClick, or the switch
    // happens and takes the comment with it. The second test is the control:
    // the same click switches when nothing is unsent.
    await card(harness.page, await reachableCard(harness.page, first)).click();
    await stays("the panel's item", () => panelKey(harness.page).innerText(), first);
    assert.equal((await commentEditorSurface(harness.page).innerText()).trim(), "Half a thought");
    assert.equal((await readComments(harness.vaultRoot, first)).length, commentsBefore, "nothing posted");

    // Clearing the text lifts the hold, and the notice with it. The first
    // click leaves the comment box, and the second closes.
    await commentEditorSurface(harness.page).click();
    await harness.page.keyboard.press("Control+A");
    await harness.page.keyboard.press("Backspace");
    await notice.waitFor({ state: "detached" });
    await clickEmpty(harness.page);
    await clickEmpty(harness.page);
    await panel(harness.page).waitFor({ state: "detached" });
  });

  test("the ✕ still closes with a comment unsent", async () => {
    await openCard(harness.page, first);
    await commentEditorSurface(harness.page).click();
    await commentEditorSurface(harness.page).pressSequentially("Going anyway");
    await panel(harness.page).getByRole("button", { name: "Close" }).click();
    await panel(harness.page).waitFor({ state: "detached" });
    assert.equal(await commentForm(harness.page).count(), 0);
  });

  test("a selection dragged out of the panel and let go over the board keeps it open", async () => {
    await openCard(harness.page, first);
    const heading = panel(harness.page).locator("h3").first();
    const box = await heading.boundingBox();
    assert.ok(box, "expected a heading to press on");
    const target = await emptySpot(harness.page);

    await harness.page.mouse.move(box!.x + 4, box!.y + box!.height / 2);
    await harness.page.mouse.down();
    await harness.page.mouse.move(target.x, target.y, { steps: 8 });
    await harness.page.mouse.up();

    await stays("the panel after a dragged selection", () => panel(harness.page).count(), 1);
  });

  test("a toolbar filter applies and leaves the panel open", async () => {
    // Still open from the check above.
    assert.equal(await panelKey(harness.page).innerText(), first);
    // Whichever filter the panel leaves uncovered. The panel sits over the
    // right of the toolbar, and which filters that hides depends on the width.
    const found = await harness.page.evaluate(() => {
      const filters = document.querySelectorAll<HTMLInputElement>(
        '.toolbar input[type="checkbox"], .toolbar input[type="search"]',
      );
      for (const el of filters) {
        const box = el.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        if (hit === el || (hit && el.labels?.[0]?.contains(hit))) {
          el.setAttribute("data-e2e-reachable", "");
          return el.type;
        }
      }
      return null;
    });
    assert.ok(found, "expected a toolbar filter the open panel does not cover");
    const filter = harness.page.locator("[data-e2e-reachable]");

    if (found === "checkbox") {
      const before = await filter.isChecked();
      await filter.click();
      await eventually("the filter applied", () => filter.isChecked(), (checked) => checked !== before);
      await stays("the panel after a filter click", () => panelKey(harness.page).innerText(), first);
      await filter.click();
    } else {
      const cardsBefore = await harness.page.locator(".board [data-item-key]").count();
      await filter.click();
      await harness.page.keyboard.type("schema");
      await eventually(
        "the filter applied",
        () => harness.page.locator(".board [data-item-key]").count(),
        (n) => n < cardsBefore,
      );
      await stays("the panel after a filter click", () => panelKey(harness.page).innerText(), first);
      await filter.fill("");
    }
  });
});
