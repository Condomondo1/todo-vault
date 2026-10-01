import { useCallback, useEffect, useMemo, useState } from "react";
import type { CreateItemInput, Item } from "todo-vault";
import type { ProjectSummary } from "@shared/api";

import {
  canCreate,
  initialValues,
  reseed as reseedValues,
  toInput,
  type ItemFormSeed,
  type ItemFormValues,
} from "./item-form";
import { legalParents } from "./pieces";

/**
 * The New item form's state, without its chrome. CreateDialog wraps it in a
 * modal; the scratch pad's promote panel will stay open beside it and refill it
 * from the next note, which is what `reseed` is for.
 *
 * Initial values are read once, at mount — the same bargain the dialog always
 * made. A caller that wants new ones calls `reseed` or `applyDraft`.
 */
export function useItemForm({
  projects,
  items,
  initial,
}: {
  projects: ProjectSummary[];
  items: Item[];
  initial?: ItemFormSeed;
}) {
  const [values, setValues] = useState<ItemFormValues>(() => initialValues(projects, initial));
  // Bumped when a value is replaced from outside, to remount the description
  // editor. It takes its content once, at mount, so that typing is never yanked
  // out from under you — which means a replaced value needs a new one.
  const [descriptionGeneration, setDescriptionGeneration] = useState(0);

  const set = useCallback(<K extends keyof ItemFormValues>(field: K, value: ItemFormValues[K]) => {
    setValues((v) => ({ ...v, [field]: value }));
  }, []);

  // The same list the detail panel's parent picker offers — see legalParents.
  const parentChoices = useMemo(
    () => legalParents(items, values.project, values.type),
    [items, values.project, values.type],
  );

  // Changing type can invalidate the chosen parent.
  useEffect(() => {
    if (values.parent && !parentChoices.some((c) => c.key === values.parent)) set("parent", "");
  }, [values.parent, parentChoices, set]);

  /**
   * Fill the form from a Claude draft. Deliberately does not submit: the draft
   * is a proposal, and the confirmation step — the user reading it and pressing
   * Create — is the whole reason this is safe to offer.
   */
  const applyDraft = useCallback((input: CreateItemInput, options: { keepCategory?: boolean } = {}) => {
    setValues((v) => ({
      ...v,
      project: input.project,
      type: input.type,
      summary: input.summary,
      description: input.description ?? "",
      ...(input.priority ? { priority: input.priority } : {}),
      dueDate: input.dueDate ?? "",
      // The promote panel keeps its sticky category when the draft names none,
      // where the New item dialog, which has nothing to keep, clears it.
      category: input.category ?? (options.keepCategory ? v.category : ""),
      labels: (input.labels ?? []).join(", "),
      cadence: input.cadence ?? "none",
      // Applied only when the draft names someone, unlike the fields above which
      // are cleared when it does not. The schema does ask Claude for a reporter
      // now, but most notes name nobody and come back empty — and an empty
      // answer must not wipe a name typed before pressing Draft, since that
      // person still asked for the work. Overwriting it when the note *does*
      // name someone is the point: a name only Claude saw would otherwise reach
      // the description body, where the reporter filter can never find it.
      ...(input.reporter ? { reporter: input.reporter } : {}),
    }));
    setDescriptionGeneration((n) => n + 1);
  }, []);

  /** Refill from a new note, keeping project, parent and category. See STICKY_FIELDS. */
  const reseed = useCallback(
    (next: Pick<ItemFormSeed, "type" | "summary" | "description">) => {
      setValues((v) => reseedValues(v, next, projects, items));
      setDescriptionGeneration((n) => n + 1);
    },
    [projects, items],
  );

  return {
    values,
    set,
    parentChoices,
    descriptionGeneration,
    applyDraft,
    reseed,
    /** The createItem payload, or null while there is nothing to create. */
    toInput: () => toInput(values),
    /** Whether the Create button should be live. */
    canCreate: (saving: boolean) => canCreate(values, saving),
  };
}

export type ItemForm = ReturnType<typeof useItemForm>;
