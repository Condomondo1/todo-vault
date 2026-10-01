import { useEffect, useRef, useState } from "react";
import type { ItemType } from "todo-vault/constants";
import type { Item } from "todo-vault";
import type { ClaudeStatus, ProjectSummary } from "@shared/api";

import { ItemFormFields } from "./ItemFormFields";
import { useItemForm } from "./useItemForm";

/**
 * New item form, shaped to CreateItemInput so the vault's own validation is the
 * only validation. Parent choices are filtered to what the hierarchy allows —
 * epics take no parent, subtasks hang off a story/task/bug, everything else off
 * an epic — so an invalid combination cannot be submitted.
 *
 * This is the modal around it: the backdrop, Escape, the Claude draft box, and
 * the Create button. The fields and their state are ItemFormFields and
 * useItemForm, which the scratch pad's promote panel shares.
 */
export function CreateDialog({
  projects,
  items,
  reporters,
  defaultProject,
  defaultType,
  defaultParent,
  onClose,
  onCreate,
}: {
  projects: ProjectSummary[];
  items: Item[];
  /** Every name the vault has used, for the Reporter menu. Derived in App. */
  reporters: string[];
  defaultProject: string | null;
  /** Optional: the toolbar and the `n` shortcut open with neither and land on `task`. */
  defaultType?: ItemType;
  defaultParent?: string;
  onClose: () => void;
  /** Resolves to an error message, or null once the item exists. */
  onCreate: (input: Record<string, unknown>) => Promise<string | null>;
}): React.JSX.Element {
  const form = useItemForm({
    projects,
    items,
    initial: {
      project: defaultProject ?? undefined,
      type: defaultType,
      parent: defaultParent,
    },
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The optional Claude layer. Null until the status call answers; the section
  // renders as unavailable rather than absent, so the feature is discoverable
  // even when it is switched off.
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [prompt, setPrompt] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [notes, setNotes] = useState("");

  const summaryRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => summaryRef.current?.focus(), []);

  useEffect(() => {
    let live = true;
    void window.vault.claudeStatus().then((result) => {
      if (live && result.ok) setClaude(result.value);
    });
    return () => {
      live = false;
    };
  }, []);

  /**
   * Fill the form from a draft. Deliberately does not submit: the draft is a
   * proposal, and the confirmation step — the user reading it and pressing
   * Create — is the whole reason this is safe to offer.
   */
  const draft = async (): Promise<void> => {
    if (!prompt.trim()) return;
    setDrafting(true);
    setError(null);

    const result = await window.vault.draftItem(prompt.trim(), form.values.project || null);
    setDrafting(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }

    form.applyDraft(result.value.input);
    setNotes(result.value.notes);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const input = form.toInput();
    if (!input) return;
    setSaving(true);
    setError(null);

    const message = await onCreate(input);

    setSaving(false);
    if (message) {
      setError(message);
      return;
    }
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <header className="modal-head">
          <h2>New item</h2>
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          {claude && (claude.storageAvailable && claude.hasKey ? (
            <div className="draft-box">
              <textarea
                className="draft-input"
                value={prompt}
                rows={2}
                placeholder="Describe it in a sentence and let Claude fill the form — e.g. “chase legal for the signed DPA, high priority, by Friday”"
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void draft();
                  }
                }}
              />
              <button
                type="button"
                className="btn"
                disabled={drafting || !prompt.trim()}
                onClick={() => void draft()}
                title="Ctrl-Enter"
              >
                {drafting ? "Drafting…" : "Draft"}
              </button>
            </div>
          ) : (
            <p className="field-note">
              Drafting is off.{" "}
              {claude.storageAvailable
                ? "Add an API key under Claude in the sidebar to turn it on."
                : "Encrypted key storage is unavailable on this machine."}
            </p>
          ))}

          {notes && (
            <div className="draft-note">
              <strong>Claude noted:</strong> {notes}
            </div>
          )}

          <ItemFormFields form={form} projects={projects} reporters={reporters} summaryRef={summaryRef} />

          {error && <div className="modal-error">{error}</div>}
        </div>

        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!form.canCreate(saving)}>
            {saving ? "Creating…" : "Create"}
          </button>
        </footer>
      </form>
    </div>
  );
}
