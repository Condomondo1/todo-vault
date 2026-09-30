/**
 * Jira's own lists of values, turned into what a value editor offers.
 *
 * Shared because two places draw the same editors: the push pane, for an
 * `ask` field's value on one push, and Settings → Jira → Mapping, for an extra
 * field's stored value. Both must offer the same choices in the same shape, or
 * a value picked in one would not be recognised as selected in the other.
 */
import type { JiraChoice } from "./api.js";

/**
 * `allowedValues` as `{ id }` choices, labelled by name or value. Ids and not
 * names, because names get renamed and an id that has gone fails loudly.
 * Entries with no string id cannot be sent that way and are left out.
 */
export function choicesFor(allowed: unknown[] | undefined): JiraChoice[] {
  return (allowed ?? []).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const e = entry as { id?: unknown; name?: unknown; value?: unknown };
    if (typeof e.id !== "string") return [];
    const label = typeof e.name === "string" ? e.name : typeof e.value === "string" ? e.value : e.id;
    return [{ value: { id: e.id }, label }];
  });
}
