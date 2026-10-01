import { useState } from "react";
import {
  CADENCES,
  ITEM_TYPES,
  PRIORITIES,
  type Cadence,
  type ItemType,
  type Priority,
} from "todo-vault/constants";
import type { ProjectSummary } from "@shared/api";

import { isLosslessDescription } from "todo-vault/description";

import { RichEditor } from "./RichEditor";
import { Suggest } from "./Editable";
import type { ItemForm } from "./useItemForm";

/**
 * The fields of the New item form: summary, the pickers, and the description
 * editor. No backdrop, no footer, no submit — those belong to whatever hosts
 * it, a modal today and the scratch pad's promote panel next. The state lives
 * in the `useItemForm` the host passes in.
 */
export function ItemFormFields({
  form,
  projects,
  reporters,
  summaryRef,
  onSubmit,
}: {
  form: ItemForm;
  projects: ProjectSummary[];
  /** Every name the vault has used, for the Reporter menu. Derived in App. */
  reporters: string[];
  /** For the host to focus the summary when it opens. */
  summaryRef?: React.Ref<HTMLInputElement>;
  /**
   * Ctrl+Enter from inside the description editor, which would otherwise keep it
   * to itself. A host that submits on Ctrl+Enter anywhere in its fields passes
   * its submit here; the plain inputs and selects need nothing, since the
   * keystroke bubbles up to the host.
   */
  onSubmit?: () => void;
}): React.JSX.Element {
  const { values, set, parentChoices, descriptionGeneration } = form;
  const [source, setSource] = useState(false);

  // Same rule the detail panel keeps: the rich editor is offered only for text
  // it can write back unchanged. A Claude draft is the one thing here that can
  // arrive using formatting outside the grammar's single spelling of it.
  const rich = !source && isLosslessDescription(values.description);

  return (
    <>
      <label>
        <span>Summary</span>
        <input
          ref={summaryRef}
          value={values.summary}
          onChange={(e) => set("summary", e.target.value)}
          placeholder="What needs doing?"
          required
        />
      </label>

      <div className="modal-row">
        <label>
          <span>Project</span>
          <select value={values.project} onChange={(e) => set("project", e.target.value)}>
            {projects.map((p) => (
              <option key={p.key} value={p.key}>
                {p.key} — {p.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Type</span>
          <select value={values.type} onChange={(e) => set("type", e.target.value as ItemType)}>
            {ITEM_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Priority</span>
          <select
            value={values.priority}
            onChange={(e) => set("priority", e.target.value as Priority)}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="modal-row">
        <label>
          <span>Parent</span>
          <select
            value={values.parent}
            onChange={(e) => set("parent", e.target.value)}
            disabled={values.type === "epic" || parentChoices.length === 0}
          >
            <option value="">
              {values.type === "epic"
                ? "epics sit at the top"
                : values.type === "subtask"
                  ? "required — pick one"
                  : "none"}
            </option>
            {parentChoices.map((candidate) => (
              <option key={candidate.key} value={candidate.key}>
                {candidate.key} — {candidate.summary}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Due</span>
          <input type="date" value={values.dueDate} onChange={(e) => set("dueDate", e.target.value)} />
        </label>

        <label>
          <span>Category</span>
          <input
            value={values.category}
            onChange={(e) => set("category", e.target.value)}
            placeholder="optional"
          />
        </label>
      </div>

      <div className="modal-row">
        <label>
          <span>Labels</span>
          <input
            value={values.labels}
            onChange={(e) => set("labels", e.target.value)}
            placeholder="comma-separated"
          />
        </label>

        <label>
          <span>Cadence</span>
          <select value={values.cadence} onChange={(e) => set("cadence", e.target.value as Cadence)}>
            {CADENCES.map((c) => (
              <option key={c} value={c}>
                {c === "none" ? "one-off" : c}
              </option>
            ))}
          </select>
        </label>

        {/*
          Who asked for this. Assignee is deliberately not here beside it: who
          wants the work is known while you are logging it, and who will do it
          usually is not yet — so it stays a detail-panel field.

          A suggesting text field rather than a select, because the menu is a
          record of what has been typed, not a roster to pick from. A name it
          has never seen is typed straight in and is on the menu from then on.

          A div rather than a <label>, for the reason the description field
          below documents: a click anywhere inside a label is forwarded to the
          control it names, so picking a name from the menu would re-focus the
          input and reopen the menu you just chose from.
        */}
        <div className="modal-field">
          <span>Reporter</span>
          <Suggest
            value={values.reporter}
            suggestions={reporters}
            placeholder="who asked for it"
            onChange={(v) => set("reporter", v)}
            onCommit={(v) => set("reporter", v)}
          />
        </div>
      </div>

      {/*
        A div, not a <label> like every other field here. Clicking a label
        activates its first labelable descendant, and that is the source
        toggle — so with the rich editor inside one, every click into the
        prose pressed the button and flipped the field to raw markdown. The
        editing surface is a contenteditable, not a form control, so there
        is nothing for a label to point at anyway.
      */}
      <div className="modal-field">
        <span>
          Description
          {/* The preview toggle this replaces answered "what will my
              markdown look like", which is no longer a question you have to
              ask. What is left is the reverse: seeing the markdown itself. */}
          <button
            type="button"
            className="add-btn"
            onClick={() => setSource((v) => !v)}
            title="Edit the raw markdown"
          >
            {source ? "rich" : "source"}
          </button>
        </span>
        {rich ? (
          // Remounted when a draft arrives: the editor takes its content
          // once, at mount, so that typing is never yanked out from under
          // you — which means a value replaced from outside needs a new one.
          <RichEditor
            key={descriptionGeneration}
            value={values.description}
            onChange={(v) => set("description", v)}
            onSubmit={onSubmit}
          />
        ) : (
          <>
            {!source && (
              <div className="field-note">
                Editing as markdown: this uses formatting the rich editor would
                rewrite.
              </div>
            )}
            <textarea
              value={values.description}
              onChange={(e) => set("description", e.target.value)}
              rows={5}
              placeholder="Markdown. This becomes the body of the file."
            />
          </>
        )}
      </div>
    </>
  );
}
