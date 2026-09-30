/**
 * What a click beside the open item's panel should do.
 *
 * The panel (`aside.detail`) has no backdrop, so the only ways out used to be
 * its ✕ and Escape. A click on empty space beside it now closes it too, the
 * way Jira's and Linear's side panels do, but never at the cost of something
 * typed. Everything that decides that lives here, as a pure function, so the
 * rules can be tested without a window. App owns the listeners and acts on the
 * answer.
 */

/** What is under the pointer, as far as the panel is concerned. */
export type OutsideTarget =
  /** Another item's card, row or chip. Clicking it switches the panel. */
  | "item"
  /** Any other control, such as a filter, the sidebar or the bulk bar. */
  | "control"
  /** Nothing that does anything, such as board background or a column gap. */
  | "empty";

export interface OutsideClickInput {
  /** `MouseEvent.button`. Only the primary button (0) can close anything. */
  button: number;
  /** Whether the press landed inside the panel. */
  downInside: boolean;
  /** Whether the release landed inside the panel. */
  upInside: boolean;
  /** A modal or the palette is up, or the click was on one. */
  overlaid: boolean;
  target: OutsideTarget;
  /** Focus is on a text field, select or rich editor inside the panel. */
  typingInPanel: boolean;
  /** The comment box has text that has not been posted. */
  unsentComment: boolean;
  /** A vault write is in flight. */
  busy: boolean;
}

export type OutsideClickAction =
  /** Close the panel. */
  | "close"
  /** Blur the field, which commits it, and keep the panel open. */
  | "leave-field"
  /**
   * Swallow the click, keep the panel, and say why. Only an unsent comment
   * does this, since it is the one thing in the panel a click would lose.
   */
  | "stay"
  /** Not this listener's business. The click does whatever it does anyway. */
  | "ignore";

export function outsideClickAction(input: OutsideClickInput): OutsideClickAction {
  if (input.button !== 0 || input.overlaid) return "ignore";
  // Both ends outside. A press inside that ends outside is a text selection
  // dragged past the panel's edge, not a click on the board.
  if (input.downInside || input.upInside) return "ignore";

  if (input.target === "control") return "ignore";

  // Switching to another item unmounts the comment box's text exactly as
  // closing does, so the same guard applies. With nothing unsent, the item's
  // own click handler switches the panel as it always has.
  if (input.target === "item") return input.unsentComment ? "stay" : "ignore";

  if (input.unsentComment) return "stay";
  // Out of the field first, the same rung Escape climbs. The blur commits the
  // edit, and the panel stays long enough for the person to see that it did.
  if (input.typingInPanel) return "leave-field";
  // Nothing is lost by a write in flight, but an error from it would have
  // nowhere to show. Too brief to be worth a notice.
  if (input.busy) return "ignore";
  return "close";
}

/**
 * What counts as a control. Clicking one does what it does and leaves the
 * panel open. A new kind of control is one entry here, not a bug report.
 */
export const CONTROL_SELECTOR = [
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  "[role=button]",
  "[role=option]",
  "[role=tab]",
  "[contenteditable]",
].join(", ");

/**
 * Every view's clickable item carries this: the board card, the backlog row,
 * the agenda row, the calendar chip and the history row. Matching an attribute
 * rather than five class names is what stops a restyled view from quietly
 * dropping out.
 */
export const ITEM_SELECTOR = "[data-item-key]";

/** What overlays render as. A click on one never counts as outside. */
export const OVERLAY_SELECTOR = ".modal-backdrop, .palette-backdrop";

/** Anything `closest` can be asked of. An `Element` in the app. */
interface Closest {
  closest(selector: string): unknown;
}

export function classifyTarget(target: Closest | null): OutsideTarget {
  if (!target) return "empty";
  // Item first: the calendar chip and the agenda row are buttons as well.
  if (target.closest(ITEM_SELECTOR)) return "item";
  if (target.closest(CONTROL_SELECTOR)) return "control";
  return "empty";
}

/**
 * The target of a click whose press and release landed on different things.
 * The browser fires `click` on their nearest common ancestor, so a card
 * dragged to another column would otherwise read as a click on the board's
 * background and close the panel. Whichever end did something wins.
 */
export function mergeTargets(down: OutsideTarget, up: OutsideTarget): OutsideTarget {
  if (down === "item" || up === "item") return "item";
  if (down === "control" || up === "control") return "control";
  return "empty";
}

export function isOnOverlay(target: Closest | null): boolean {
  return Boolean(target?.closest(OVERLAY_SELECTOR));
}
