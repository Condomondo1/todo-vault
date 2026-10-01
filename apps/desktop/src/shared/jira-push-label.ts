/**
 * What the push pane's one button says, and what it will send for updates.
 *
 * Pure and shared so the rules are tested apart from the pane: the label must
 * say exactly what the press does, because it writes into a tracker other
 * people read.
 */
import type { JiraUpdateChoice, JiraUpdateView } from "./api.js";

/**
 * "Create 2 issues in ENG", "Update 1 issue in ENG", or "Create 2 and update 1
 * in ENG". A half with nothing in it is left out. With neither, the create
 * form stays, so an empty pane still says what the button is for.
 */
export function pushButtonLabel(creates: number, updates: number, projectKey: string): string {
  const issues = (n: number): string => `${n} issue${n === 1 ? "" : "s"}`;
  if (creates > 0 && updates > 0) return `Create ${creates} and update ${updates} in ${projectKey}`;
  if (updates > 0) return `Update ${issues(updates)} in ${projectKey}`;
  return `Create ${issues(creates)} in ${projectKey}`;
}

/**
 * What to send per changed item: the editable changes still ticked, and every
 * change the pane showed, so main can tell a difference the person saw from
 * one that appeared after they looked.
 *
 * An item with nothing ticked is left out. Unticking every field is how one
 * item is held back from a push, so it means "not now", and the item keeps
 * reading as changed. Some ticked is a decision per field: the unticked ones
 * keep Jira's values, and the restamp stops them being offered again. An item
 * whose issue already matches is not listed either: that takes "Mark as in
 * sync".
 */
export function updateFieldChoices(
  updates: readonly JiraUpdateView[],
  unticked: Readonly<Record<string, readonly string[]>>,
): Record<string, JiraUpdateChoice> {
  const out: Record<string, JiraUpdateChoice> = {};
  for (const update of updates) {
    const off = new Set(unticked[update.localKey] ?? []);
    const ticked = update.changes.filter((c) => c.editable && !off.has(c.fieldId)).map((c) => c.fieldId);
    if (ticked.length === 0) continue;
    out[update.localKey] = { ticked, seen: update.changes.map((c) => c.fieldId) };
  }
  return out;
}
