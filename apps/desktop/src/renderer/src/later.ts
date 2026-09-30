// The recurrence subpath, not the package root — see the note at the top of
// pieces.tsx: the root pulls vault.js, and node:fs with it, into the bundle.
import { isTickedFor } from "todo-vault/recurrence";
import type { Item } from "todo-vault";

/**
 * Whether an item is open but not something to do *today* — the reading behind
 * the toolbar's "Hide later".
 *
 * Two different reasons, deliberately folded into one control because they
 * answer the same question from the person looking at the pile:
 *
 * - **Its start is still ahead.** A `todo` whose `startDate` is after today.
 *   Only `todo`: anything already in progress, in review or blocked has begun
 *   whatever the date says — and moving into `in_progress` stamps `startDate`
 *   with today anyway, so a future start on a started item is a hand edit
 *   worth keeping in view, not hiding.
 * - **This period's turn is done.** A recurring item already ticked for the
 *   period containing today. It comes back on its own when the period turns,
 *   which is what makes hiding it safe — the agenda already drops settled
 *   items for the same reason.
 *
 * Derived, never stored. Both conditions come true or stop being true on the
 * clock, and IDEAS.md's "Scheduled as a seventh status" entry sets out why a
 * status for that would go stale the morning it came true.
 *
 * Closed items are not "later"; `Hide closed` is the control for those, and
 * keeping the two independent means neither checkbox changes what the other
 * means.
 */
export function isLater(
  item: Pick<Item, "status" | "startDate" | "cadence" | "completions">,
  today: string,
): boolean {
  if (item.status === "done" || item.status === "disregard") return false;
  if (item.status === "todo" && item.startDate !== undefined && item.startDate > today) return true;
  // A one-off has no period, so isTickedFor is already false for it.
  return isTickedFor(item, today);
}
