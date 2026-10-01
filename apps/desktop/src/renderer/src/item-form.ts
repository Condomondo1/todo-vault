import type { Cadence, ItemType, Priority } from "todo-vault/constants";
import type { CreateItemInput, Item } from "todo-vault";

import { legalParents } from "./pieces";

/**
 * What the New item form holds, as the form holds it: text boxes stay strings
 * (labels are comma-separated, a due date is "" until picked) and are turned
 * into a CreateItemInput only by `toInput`. The pure half of `useItemForm`,
 * kept apart so the rules can be tested without rendering a component.
 */
export interface ItemFormValues {
  project: string;
  type: ItemType;
  summary: string;
  description: string;
  priority: Priority;
  parent: string;
  dueDate: string;
  category: string;
  labels: string;
  cadence: Cadence;
  reporter: string;
}

/** The fields a caller may set when it opens the form. Everything else starts empty. */
export type ItemFormSeed = Partial<Pick<ItemFormValues, "project" | "type" | "parent" | "summary" | "description">>;

/**
 * What survives from one item to the next when the form is refilled from a new
 * note rather than closed and reopened: a batch of notes usually belongs to one
 * project, often to one epic, and is filed under one category. Type, summary
 * and description come from the note itself; the rest go back to their
 * defaults, because a due date or a reporter carried to an unrelated item is
 * a mistake nobody sees until later.
 */
export const STICKY_FIELDS = ["project", "parent", "category"] as const satisfies readonly (keyof ItemFormValues)[];

export function initialValues(projects: { key: string }[], seed: ItemFormSeed = {}): ItemFormValues {
  return {
    project: seed.project ?? projects[0]?.key ?? "",
    type: seed.type ?? "task",
    summary: seed.summary ?? "",
    description: seed.description ?? "",
    priority: "medium",
    parent: seed.parent ?? "",
    dueDate: "",
    category: "",
    labels: "",
    cadence: "none",
    reporter: "",
  };
}

/** The parent, or "" if the hierarchy does not allow it for this project and type. */
export function validParent(items: Item[], project: string, type: ItemType, parent: string): string {
  if (!parent) return "";
  return legalParents(items, project, type).some((c) => c.key === parent) ? parent : "";
}

/**
 * The form refilled from a new note. The sticky fields are kept as they were,
 * the note's own type, summary and description replace what was there, and the
 * parent is checked again against the new type — a subtask's story is not a
 * legal parent for the next note if that one is an epic.
 *
 * A project that has since gone (hidden, or the vault changed under the form)
 * falls back to the first one, for the same reason `initialValues` starts there.
 */
export function reseed(
  current: ItemFormValues,
  next: Pick<ItemFormSeed, "type" | "summary" | "description">,
  projects: { key: string }[],
  items: Item[],
): ItemFormValues {
  const fresh = initialValues(projects, next);
  const kept = Object.fromEntries(STICKY_FIELDS.map((field) => [field, current[field]]));
  const merged: ItemFormValues = { ...fresh, ...kept };
  if (!projects.some((p) => p.key === merged.project)) merged.project = fresh.project;
  merged.parent = validParent(items, merged.project, merged.type, merged.parent);
  return merged;
}

/**
 * The payload for createItem, or null while there is nothing to create — no
 * summary, or no project to put it in. Shaped to CreateItemInput so the
 * vault's own validation stays the only validation; the one rule checked here
 * is the one that is about this form's text boxes, not about the item.
 */
export function toInput(values: ItemFormValues): CreateItemInput | null {
  const summary = values.summary.trim();
  if (!summary || !values.project) return null;

  return {
    project: values.project,
    type: values.type,
    summary,
    description: values.description.trim(),
    priority: values.priority,
    parent: values.parent || undefined,
    dueDate: values.dueDate || undefined,
    category: values.category.trim() || undefined,
    // Comma-separated in, array out — same shape as EditableList uses in the
    // detail panel, so the two ways of setting labels agree.
    labels: values.labels
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    cadence: values.cadence,
    reporter: values.reporter.trim() || undefined,
  };
}

/**
 * Whether Create should be offered. A subtask with no parent is refused by the
 * vault anyway; greying the button saves the round trip. Deliberately not part
 * of `toInput`'s null: pressing Enter in the summary of a parentless subtask
 * has always sent it and shown the vault's own message.
 */
export function canCreate(values: ItemFormValues, saving: boolean): boolean {
  return !saving && values.summary.trim() !== "" && !(values.type === "subtask" && !values.parent);
}
