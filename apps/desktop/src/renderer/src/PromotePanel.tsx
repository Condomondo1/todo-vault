import { useEffect, useMemo, useRef, useState } from "react";
import type { CreateItemInput, Item, ScratchNote } from "todo-vault";
import type { ClaudeStatus, ProjectSummary } from "@shared/api";

import { ItemFormFields } from "./ItemFormFields";
import { prefill } from "./promote";
import { shortAge } from "./scratch";
import { useItemForm } from "./useItemForm";

/** What carries from one promote to the next. See STICKY_FIELDS in item-form.ts. */
export interface StickyFields {
  project: string;
  parent: string;
  category: string;
}

/**
 * The promote panel: the note on top, the New item form under it, beside the
 * Scratch page so the note stays visible while the form is filled.
 *
 * It stays mounted as the selection moves from note to note, which is what lets
 * the form carry project, parent and category from one item to the next: a
 * different note refills type, summary and description (`reseed`) and leaves
 * the rest. After Create the host selects the next note and focus goes back to
 * Summary, so a pile of notes is Ctrl+Enter, Ctrl+Enter, …
 *
 * Nothing here calls Claude. The prefill is a local guess from the note's text.
 */
export function PromotePanel({
  note,
  projects,
  items,
  reporters,
  defaultProject,
  sticky,
  focusToken,
  onClose,
  onPromote,
}: {
  note: ScratchNote;
  projects: ProjectSummary[];
  items: Item[];
  /** Every name the vault has used, for the Reporter menu. Derived in App. */
  reporters: string[];
  /** The sidebar's project, for the first note of a session. */
  defaultProject: string | null;
  /** What the last promote used, remembered by the host across the panel closing. */
  sticky: StickyFields | null;
  /** A new number asks for Summary to take focus (Enter or p on a note). */
  focusToken: number | null;
  onClose: () => void;
  /**
   * Resolves to an error message and, when the item was written anyway, its key:
   * the core says "Created KEY, but the note stayed on the scratch pad" and a
   * retry after that would make the item twice.
   */
  onPromote: (
    noteId: string,
    input: CreateItemInput,
    keep: boolean,
  ) => Promise<{ error: string | null; createdKey: string | null }>;
}): React.JSX.Element {
  const first = useMemo(() => prefill(note.text), []); // eslint-disable-line react-hooks/exhaustive-deps
  const form = useItemForm({
    projects,
    items,
    initial: {
      project: sticky?.project ?? defaultProject ?? undefined,
      parent: sticky?.parent || undefined,
      category: sticky?.category || undefined,
      type: first.type,
      summary: first.summary,
      description: first.description,
    },
  });

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Set when the item exists but the note could not be trashed: Create is then
  // off for this note, so the only way forward is not a duplicate.
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  // The summary the 255-character cut produced, while it is still what is typed.
  const [cutSummary, setCutSummary] = useState<string | null>(first.cut ? first.summary : null);
  const summaryRef = useRef<HTMLInputElement | null>(null);

  // The optional Claude layer, as the New item dialog has it: null until the
  // status answers, and drafting is shown as off rather than absent.
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [claudeNote, setClaudeNote] = useState("");
  // Which note a draft was asked for, so a reply that arrives after the
  // selection has moved on is dropped instead of landing in another note's form.
  const draftFor = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    void window.vault.claudeStatus().then((result) => {
      if (live && result.ok) setClaude(result.value);
    });
    return () => {
      live = false;
    };
  }, []);

  // A different note refills the form, keeping what is sticky. The first note is
  // already in the form from mount, so there is nothing to do for it.
  const seen = useRef(note.id);
  useEffect(() => {
    if (seen.current === note.id) return;
    seen.current = note.id;
    const next = prefill(note.text);
    form.reseed({ type: next.type, summary: next.summary, description: next.description });
    setCutSummary(next.cut ? next.summary : null);
    setCreatedKey(null);
    setError(null);
    setClaudeNote("");
    setDrafting(false);
    draftFor.current = null;
  }, [note.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (focusToken !== null) summaryRef.current?.focus();
  }, [focusToken]);

  /**
   * Fill the form from Claude's reading of this note. Only ever on a click: it
   * sends the note's text to the API, which a pasted query or a token should
   * never do on its own. The draft is a proposal. The form shows it, and
   * pressing Create is what makes it an item.
   */
  const draft = async (): Promise<void> => {
    const asked = note.id;
    draftFor.current = asked;
    setDrafting(true);
    setError(null);

    const result = await window.vault.draftItem(note.text, form.values.project || null);
    if (draftFor.current !== asked) return;
    setDrafting(false);
    draftFor.current = null;

    if (!result.ok) {
      setError(result.message);
      return;
    }
    form.applyDraft(result.value.input, { keepCategory: true });
    setCutSummary(null);
    setClaudeNote(result.value.notes);
  };

  const submit = async (keep: boolean): Promise<void> => {
    if (saving || createdKey) return;
    const input = form.toInput();
    if (!input || !form.canCreate(false)) return;

    setSaving(true);
    setError(null);
    const result = await onPromote(note.id, input, keep);
    setSaving(false);

    if (result.createdKey && result.error) {
      setCreatedKey(result.createdKey);
      setError(result.error);
      return;
    }
    if (result.error) {
      setError(result.error);
      return;
    }
    summaryRef.current?.focus();
  };

  const disabled = saving || createdKey !== null || !form.canCreate(false);

  return (
    <aside
      className="promote"
      aria-label="Promote to item"
      onKeyDown={(e) => {
        // From any plain field. The description editor keeps this chord for
        // itself and passes it on through ItemFormFields' onSubmit instead.
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void submit(false);
        }
      }}
    >
      <header className="detail-head">
        <h2 className="promote-title">Promote to item</h2>
        <div className="spacer" />
        <button type="button" className="btn" onClick={onClose} title="Close (Esc)" aria-label="Close">
          ✕
        </button>
      </header>

      <form
        className="promote-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
      >
        <div className="modal-body promote-body">
          <div className="promote-origin">
            <div className="promote-origin-head">From scratch · {shortAge(note.created)}</div>
            {note.text}
          </div>

          {claude && (claude.storageAvailable && claude.hasKey ? (
            <div className="promote-draft">
              <button
                type="button"
                className="btn"
                disabled={drafting || saving}
                onClick={() => void draft()}
              >
                {drafting ? "Drafting…" : "✦ Draft with Claude"}
              </button>
              <span className="field-note">
                Sends this note to the Claude API — only when you click.
              </span>
            </div>
          ) : (
            <p className="field-note">
              Drafting is off.{" "}
              {claude.storageAvailable
                ? "Add an API key under Claude in the sidebar to turn it on."
                : "Encrypted key storage is unavailable on this machine."}
            </p>
          ))}

          {claudeNote && (
            <div className="draft-note">
              <strong>Claude noted:</strong> {claudeNote}
            </div>
          )}

          <ItemFormFields
            form={form}
            projects={projects}
            reporters={reporters}
            summaryRef={summaryRef}
            onSubmit={() => void submit(false)}
          />

          {cutSummary !== null && form.values.summary === cutSummary && (
            <div className="field-note">
              The first line was longer than 255 characters. It is cut at a word, and the rest is
              in the description.
            </div>
          )}
          {error && <div className="modal-error">{error}</div>}
          {createdKey && (
            <div className="field-note">
              {createdKey} exists. Remove the note, or pick another, rather than creating it again.
            </div>
          )}
        </div>

        <footer className="modal-foot">
          <span className="field-note promote-hint">Ctrl+Enter from any field</span>
          <div className="spacer" />
          <button
            type="button"
            className="btn"
            disabled={disabled}
            onClick={() => void submit(true)}
            title="Create the item and leave the note on the pad"
          >
            Create &amp; keep note
          </button>
          <button type="submit" className="btn btn-primary" disabled={disabled}>
            {saving ? "Creating…" : "Create item"}
          </button>
        </footer>
      </form>
    </aside>
  );
}
