import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyTarget,
  CONTROL_SELECTOR,
  isOnOverlay,
  ITEM_SELECTOR,
  mergeTargets,
  outsideClickAction,
  type OutsideClickInput,
} from "../src/renderer/src/outside-click.js";

/** A plain left click on empty space, with nothing outstanding. */
function click(overrides: Partial<OutsideClickInput> = {}): OutsideClickInput {
  return {
    button: 0,
    downInside: false,
    upInside: false,
    overlaid: false,
    target: "empty",
    typingInPanel: false,
    unsentComment: false,
    busy: false,
    ...overrides,
  };
}

test("a click on empty space with nothing outstanding closes the panel", () => {
  assert.equal(outsideClickAction(click()), "close");
});

test("only a primary-button click, with both ends outside, counts", () => {
  assert.equal(outsideClickAction(click({ button: 2 })), "ignore", "right-click");
  assert.equal(outsideClickAction(click({ button: 1 })), "ignore", "middle-click");
  // A text selection dragged out of the description and let go over the board.
  assert.equal(outsideClickAction(click({ downInside: true })), "ignore");
  assert.equal(outsideClickAction(click({ upInside: true })), "ignore");
});

test("a modal or the palette makes every click someone else's", () => {
  assert.equal(outsideClickAction(click({ overlaid: true })), "ignore");
  assert.equal(outsideClickAction(click({ overlaid: true, unsentComment: true })), "ignore");
});

test("a field being edited is left first, and the next click closes", () => {
  assert.equal(outsideClickAction(click({ typingInPanel: true })), "leave-field");
  assert.equal(outsideClickAction(click({ typingInPanel: false })), "close");
});

test("an unsent comment holds the panel open against empty space and other items", () => {
  assert.equal(outsideClickAction(click({ unsentComment: true })), "stay");
  // Focus in the comment box itself is still a stay, not a leave-field: the
  // blur would keep the text, but the next click would then close and lose it.
  assert.equal(outsideClickAction(click({ unsentComment: true, typingInPanel: true })), "stay");
  assert.equal(outsideClickAction(click({ unsentComment: true, target: "item" })), "stay");
});

test("another item switches the panel as before, and a control keeps its meaning", () => {
  assert.equal(outsideClickAction(click({ target: "item" })), "ignore");
  assert.equal(outsideClickAction(click({ target: "control" })), "ignore");
  // Filtering the board with a comment half-typed loses nothing.
  assert.equal(outsideClickAction(click({ target: "control", unsentComment: true })), "ignore");
});

test("a write in flight keeps the panel open, without a notice", () => {
  assert.equal(outsideClickAction(click({ busy: true })), "ignore");
});

/**
 * Stands in for an Element. `closest` matches when any comma-separated part of
 * the selector is one this element (or an ancestor) is said to match.
 */
function element(...matches: string[]): { closest(selector: string): unknown } {
  return {
    closest: (selector) =>
      selector
        .split(",")
        .map((part) => part.trim())
        .some((part) => matches.includes(part))
        ? {}
        : null,
  };
}

test("every control type in the list reads as a control", () => {
  for (const part of CONTROL_SELECTOR.split(",").map((p) => p.trim())) {
    assert.equal(classifyTarget(element(part)), "control", part);
  }
});

test("an item's card, row or chip reads as an item even when it is also a button", () => {
  assert.equal(classifyTarget(element(ITEM_SELECTOR)), "item");
  assert.equal(classifyTarget(element(ITEM_SELECTOR, "button")), "item", "calendar chip");
  assert.equal(classifyTarget(element(ITEM_SELECTOR, "[role=button]")), "item", "board card");
});

test("anything else, or no element at all, is empty space", () => {
  assert.equal(classifyTarget(element("div")), "empty");
  assert.equal(classifyTarget(null), "empty");
});

test("a click whose ends landed on different things takes the busier end", () => {
  // A card dragged to another column: the click lands on the board itself.
  assert.equal(mergeTargets("item", "empty"), "item");
  assert.equal(mergeTargets("empty", "control"), "control");
  assert.equal(mergeTargets("control", "item"), "item");
  assert.equal(mergeTargets("empty", "empty"), "empty");
});

test("a modal backdrop and the palette backdrop are overlays", () => {
  assert.equal(isOnOverlay(element(".modal-backdrop")), true);
  assert.equal(isOnOverlay(element(".palette-backdrop")), true);
  assert.equal(isOnOverlay(element("div")), false);
  assert.equal(isOnOverlay(null), false);
});
