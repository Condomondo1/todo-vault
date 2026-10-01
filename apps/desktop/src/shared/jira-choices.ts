/**
 * Jira's own lists of values, turned into what a value editor offers, and the
 * small readings each editor does of a stored value.
 *
 * Shared because two places draw the same editors: the push pane, for an
 * `ask` field's value on one push, and Settings → Jira → Mapping, for an extra
 * field's stored value. Both must offer the same choices in the same shape, or
 * a value picked in one would not be recognised as selected in the other.
 *
 * What an editor stores is what a person means: an option as `{ id }`, a
 * paragraph as markdown, a person as `{ accountId }`, a list as an array. The
 * core's `shapeFieldValue` turns that into Jira's create shape when the push is
 * planned, and leaves a value already in that shape alone, so a map written
 * before the editors changed still pushes.
 */
import type { JiraChoice, JiraPersonLink } from "./api.js";

/**
 * `allowedValues` as `{ id }` choices, labelled by name or value. Ids and not
 * names, because names get renamed and an id that has gone fails loudly.
 * Entries with no string id cannot be sent that way and are left out. A
 * cascading select's second level comes along as `children`.
 */
export function choicesFor(allowed: unknown[] | undefined): JiraChoice[] {
  return (allowed ?? []).flatMap((entry): JiraChoice[] => {
    if (!entry || typeof entry !== "object") return [];
    const e = entry as { id?: unknown; name?: unknown; value?: unknown; children?: unknown };
    if (typeof e.id !== "string") return [];
    const label = typeof e.name === "string" ? e.name : typeof e.value === "string" ? e.value : e.id;
    const children = Array.isArray(e.children) ? choicesFor(e.children) : [];
    return [{ value: { id: e.id }, label, ...(children.length ? { children } : {}) }];
  });
}

const idOf = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
};

/**
 * Where a cascading value sits in its choices: the parent's index and the
 * child's, -1 for none. Read from `{ id, child: { id } }`, the shape the two
 * selects store. A typed `Parent / Child` is matched by label too, so a value
 * written by hand into the map still shows as selected.
 */
export function cascadingIndexes(choices: JiraChoice[], value: unknown): { parent: number; child: number } {
  let parentId = idOf(value);
  let childId = value && typeof value === "object" ? idOf((value as { child?: unknown }).child) : undefined;
  let parentLabel: string | undefined;
  let childLabel: string | undefined;
  if (typeof value === "string") {
    [parentLabel, childLabel] = value.split(/\s*[/>]\s*/, 2).map((s) => s.trim().toLowerCase());
    parentId = childId = undefined;
  }
  const parent = choices.findIndex((c) =>
    parentId !== undefined ? idOf(c.value) === parentId : c.label.toLowerCase() === parentLabel,
  );
  const kids = parent >= 0 ? (choices[parent].children ?? []) : [];
  const child = kids.findIndex((c) =>
    childId !== undefined ? idOf(c.value) === childId : childLabel !== undefined && c.label.toLowerCase() === childLabel,
  );
  return { parent, child };
}

/** The value two cascading selects stand for. A parent alone is a valid choice; no parent is no value. */
export function cascadingValue(choices: JiraChoice[], parent: number, child: number): unknown {
  const p = choices[parent];
  if (!p) return null;
  const c = p.children?.[child];
  return c ? { ...(p.value as object), child: c.value } : p.value;
}

/** The map's linked people as a picker's choices, labelled by their Jira name, sorted. */
export function peopleChoices(people: Readonly<Record<string, JiraPersonLink>>): JiraChoice[] {
  const byAccount = new Map<string, string>();
  for (const [name, link] of Object.entries(people)) {
    if (!byAccount.has(link.accountId)) byAccount.set(link.accountId, link.displayName ?? name);
  }
  return [...byAccount]
    .map(([accountId, label]) => ({ value: { accountId }, label }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

/** The account a stored `{ accountId }` names. A typed string is not one; see `chosenPeople`. */
export function accountIdOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as { accountId?: unknown }).accountId;
  return typeof id === "string" ? id : undefined;
}

/** One person in a user field: a known account, or text written by hand that names nobody linked. */
export type ChosenPerson = { accountId: string } | { typed: string };

/**
 * A user field's stored value as the people it names, read the way the core's
 * `shapeUser` reads it: `{ accountId }` as it is, a name through the map's
 * people (case-folded), and a string shaped like an account id as one. Anything
 * else stays the text it was. Wrapping a name in `{ accountId }` would send
 * Jira an account that does not exist, where left as text the push can still
 * look it up or block on it by name.
 *
 * Accepts one value, an array, or a comma string, since a hand-written map can
 * hold any of them.
 */
export function chosenPeople(value: unknown, people: Readonly<Record<string, JiraPersonLink>>): ChosenPerson[] {
  const entries = Array.isArray(value) ? value : typeof value === "string" ? parseList(value) : value == null ? [] : [value];
  return entries.flatMap((entry): ChosenPerson[] => {
    const id = accountIdOf(entry);
    if (id) return [{ accountId: id }];
    if (typeof entry !== "string" || !entry.trim()) return [];
    const typed = entry.trim();
    const wanted = typed.toLowerCase();
    for (const [name, link] of Object.entries(people)) {
      if (name.trim().toLowerCase() === wanted) return [{ accountId: link.accountId }];
    }
    if (/^[0-9a-f]{24}$/i.test(typed) || /^\d+:[0-9a-f-]{36}$/i.test(typed)) return [{ accountId: typed }];
    return [{ typed }];
  });
}

/** What a picker stores for its people: accounts as `{ accountId }`, unresolved text as text. */
export function storedPeople(chosen: ChosenPerson[]): unknown[] {
  return chosen.map((c) => ("accountId" in c ? { accountId: c.accountId } : c.typed));
}

/** A list value as the text of a comma input. A string is shown as it was typed. */
export function listText(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(", ");
  return value === undefined || value === null ? "" : String(value);
}

/** What a comma input stores: its parts, trimmed, with empties dropped. */
export function parseList(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A stored date-time as a `datetime-local` input shows it. That input takes
 * `2026-10-01T09:30` and nothing else, so a full ISO value with seconds and an
 * offset, which a map written before the editors changed holds, is read as the
 * local time it stands for.
 */
export function localDatetime(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const s = value.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return s;
  const when = new Date(s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  if (Number.isNaN(when.getTime())) return "";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`;
}
