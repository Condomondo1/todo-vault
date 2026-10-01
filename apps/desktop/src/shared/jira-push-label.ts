/**
 * What the push pane's one button says, and what it will send for updates.
 *
 * Pure and shared so the rules are tested apart from the pane: the label must
 * say exactly what the press does, because it writes into a tracker other
 * people read.
 */
import type { JiraUpdateView } from "./api.js";

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
 * The field ids to send per changed item: every editable change not unticked.
 *
 * An item with changes is always listed, even with nothing ticked. Leaving
 * every field as Jira has it is a decision about each one, and the restamp
 * that follows stops the same fields being offered at every push. An item
 * whose issue already matches is not listed: that takes "Mark as in sync".
 */
export function updateFieldChoices(
  updates: readonly JiraUpdateView[],
  unticked: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const update of updates) {
    if (update.changes.length === 0) continue;
    const off = new Set(unticked[update.localKey] ?? []);
    out[update.localKey] = update.changes.filter((c) => c.editable && !off.has(c.fieldId)).map((c) => c.fieldId);
  }
  return out;
}
