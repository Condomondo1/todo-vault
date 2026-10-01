import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ScratchNote } from "todo-vault";

import { Markdown } from "./Markdown";
import { PastePrompt } from "./PastePrompt";
import { shortAge } from "./scratch";
import { usePasteSplit } from "./usePasteSplit";

/**
 * The Scratch page: a capture box, then every note, newest first.
 *
 * The box is focused on arrival only, and when App asks again with a fresh
 * `focusToken` (`c`, Shift+N, the sidebar's "+ new"). It is never refocused
 * after an add or a remove: a box that always holds focus swallows every bare
 * key, so `j`, `k` and `x` would never reach the list. Escape leaves it.
 *
 * A note is edited in place: double-click its card, or `e` on the selected one
 * (App asks with a fresh `editToken`). The edit lives here, keyed by the note's
 * id rather than inside the card, because the save itself refreshes the list and
 * a note promoted or removed elsewhere mid-edit takes its card with it. The text
 * must outlive both.
 */
export function ScratchPage({
  notes,
  selectedId,
  focusToken,
  editToken,
  onSelect,
  onAdd,
  onUpdate,
  onAddMany,
  onRemove,
  onOpenLink,
}: {
  notes: ScratchNote[];
  selectedId: string | null;
  /** A new number asks for the capture box to take focus; null leaves it alone. */
  focusToken: number | null;
  /** A new number asks to edit the selected note; null leaves it alone. */
  editToken: number | null;
  onSelect: (id: string | null) => void;
  /** Resolves to an error message, or null once the note is saved. */
  onAdd: (text: string) => Promise<string | null>;
  /** Replace a note's text. Same resolve as onAdd. */
  onUpdate: (id: string, text: string) => Promise<string | null>;
  /** One note per line, for a paste the person chose to split. Same resolve as onAdd. */
  onAddMany: (lines: string[]) => Promise<{ saved: number; error: string | null }>;
  onRemove: (id: string) => void;
  onOpenLink: (href: string) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (focusToken !== null) boxRef.current?.focus();
  }, [focusToken]);

  useEffect(() => {
    if (!selectedId) return;
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const [editing, setEditing] = useState<Edit | null>(null);
  // A save in flight, so the blur that follows a Ctrl+Enter cannot send it again.
  const saving = useRef(false);

  const startEdit = (note: ScratchNote): void => {
    onSelect(note.id);
    setEditing({ id: note.id, draft: note.text, error: null, missing: false });
  };

  useEffect(() => {
    if (editToken === null || selectedId === null) return;
    const note = notes.find((n) => n.id === selectedId);
    if (note) startEdit(note);
    // Only a new token asks; a list refresh or a new selection must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editToken]);

  const editedNote = editing ? notes.find((n) => n.id === editing.id) : undefined;
  // Promoted or removed while it was open: by Claude, say, or from the sidebar.
  const gone = editing !== null && (editing.missing || editedNote === undefined);

  /** Ctrl+Enter or leaving the box. One commit per save; unchanged text is none. */
  const saveEdit = async (): Promise<void> => {
    if (!editing || gone || saving.current) return;
    const { id, draft: text } = editing;
    if (editedNote && text === editedNote.text) {
      setEditing(null);
      return;
    }
    saving.current = true;
    const message = await onUpdate(id, text);
    saving.current = false;
    setEditing((current) => {
      if (current?.id !== id) return current;
      if (message?.startsWith("No scratch note")) return { ...current, error: null, missing: true };
      if (message) return { ...current, error: message };
      // Typing that went on during the save stays open, for the next save.
      return current.draft === text ? null : current;
    });
  };

  /** The way out of a note that has gone: keep the text, as a note of its own. */
  const saveAsNew = async (): Promise<void> => {
    if (!editing || saving.current) return;
    const { id, draft: text } = editing;
    saving.current = true;
    const message = await onAdd(text);
    saving.current = false;
    setEditing((current) => (current?.id !== id ? current : message ? { ...current, error: message } : null));
  };

  const editor = (): React.JSX.Element | null =>
    editing && (
      <NoteEditor
        edit={editing}
        gone={gone}
        onChange={(next) => setEditing((current) => current && { ...current, draft: next })}
        onSave={() => void saveEdit()}
        onSaveAsNew={() => void saveAsNew()}
        onCancel={() => setEditing(null)}
      />
    );

  const paste = usePasteSplit({ draft, setDraft, addNotes: onAddMany });

  const submit = async (): Promise<void> => {
    if (!draft.trim()) return;
    const message = await onAdd(draft);
    if (message) {
      setError(message);
      return;
    }
    setError(null);
    setDraft("");
  };

  const now = new Date();

  return (
    <div className="scratch-page">
      <div className="capture">
        <textarea
          ref={boxRef}
          value={draft}
          placeholder="Jot something down… a snippet, a link, half a thought."
          aria-label="New scratch note"
          onChange={(e) => setDraft(e.target.value)}
          onPaste={paste.onPaste}
          onKeyDown={(e) => {
            // Not stopped from reaching the window: its handler already ignores
            // bare keys aimed at a text field, and Ctrl-K has to keep working here.
            if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
              e.preventDefault();
              // Enter on a pasted list is the answer "one note", as Escape is.
              paste.keepOne();
              void submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              if (paste.isAsking) {
                // Answers the question and nothing else: the box keeps focus,
                // which the window's own Escape (blur) would otherwise take.
                e.stopPropagation();
                paste.keepOne();
                return;
              }
              e.currentTarget.blur();
              if (selectedId === null && notes.length > 0) onSelect(notes[0].id);
            }
          }}
        />
        {paste.lines !== null && (
          <PastePrompt
            lines={paste.lines}
            busy={paste.busy}
            error={paste.error}
            onSplit={() => void paste.splitAll()}
            onKeep={paste.keepOne}
          />
        )}
        <div className="capture-foot">
          <span>
            <kbd>Enter</kbd> add <kbd>Shift+Enter</kbd> newline <kbd>Esc</kbd> leave the box
          </span>
          <span className="spacer" />
          <span>Global — not filed under any project</span>
        </div>
        {error && <div className="modal-error capture-error">{error}</div>}
      </div>

      {/* Its card has left the list, so the text and the way to keep it sit above it. */}
      {gone && editedNote === undefined && <div className="scratch-orphan">{editor()}</div>}

      {notes.length === 0 ? (
        <div className="empty">
          <h3>Nothing on the scratch pad</h3>
          <p>
            Dump ideas, snippets and half-formed to-dos above. Promote the keepers into items
            later, or clear them.
          </p>
        </div>
      ) : (
        <div className="scratch-list" role="listbox" aria-label="Scratch notes" ref={listRef}>
          {notes.map((note) => (
            <div
              key={note.id}
              className="scratch-card"
              role="option"
              aria-selected={note.id === selectedId}
              data-note-id={note.id}
              onClick={() => onSelect(note.id)}
              onDoubleClick={() => {
                if (editing?.id !== note.id) startEdit(note);
              }}
            >
              <div>
                {editing?.id === note.id ? (
                  editor()
                ) : (
                  <div className="scratch-text prose">
                    <Markdown source={note.text} onOpenLink={onOpenLink} />
                  </div>
                )}
                <div className="scratch-meta">{shortAge(note.created, now)}</div>
              </div>
              <button
                className="scratch-x"
                title="Remove (x) — goes to Trash, Undo in the toast"
                aria-label="Remove note"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(note.id);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface Edit {
  id: string;
  draft: string;
  error: string | null;
  /** The save was refused with "No scratch note": the file is gone. */
  missing: boolean;
}

/**
 * A note's text in a box, in place of its Markdown. Ctrl+Enter or leaving the box
 * saves, Escape puts the note back as it was. Once the note has gone, neither
 * saves: the text stays, with Save as a new note and Discard beside it, and
 * Escape only leaves the box, since a slip of the key must not lose it.
 */
function NoteEditor({
  edit,
  gone,
  onChange,
  onSave,
  onSaveAsNew,
  onCancel,
}: {
  edit: Edit;
  gone: boolean;
  onChange: (next: string) => void;
  onSave: () => void;
  onSaveAsNew: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  // Escape unmounts the box, and a blur on the way out must not save what was
  // just thrown away.
  const cancelled = useRef(false);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);

  // As tall as the text, so a long one-line note is not read through a slot.
  // The stylesheet caps it, past which the box scrolls.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [edit.draft]);

  return (
    <div className="scratch-edit" onClick={(e) => e.stopPropagation()}>
      <textarea
        aria-label="Edit scratch note"
        value={edit.draft}
        rows={2}
        ref={(el) => {
          boxRef.current = el;
          // Once, on the way in, with the caret at the end of the text.
          if (el && el.dataset.focused !== "1") {
            el.dataset.focused = "1";
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
          }
        }}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          if (!cancelled.current) onSave();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (gone) onSaveAsNew();
            else onSave();
          } else if (e.key === "Escape") {
            // Handled here, or App's Escape would blur the box, and a blur saves.
            e.preventDefault();
            e.stopPropagation();
            if (gone) {
              e.currentTarget.blur();
              return;
            }
            cancelled.current = true;
            onCancel();
          }
        }}
      />
      {gone ? (
        <div className="scratch-gone">
          <span>This note was promoted or removed while you were editing it.</span>
          <button className="btn btn-primary" onMouseDown={(e) => e.preventDefault()} onClick={onSaveAsNew}>
            Save as a new note
          </button>
          <button className="btn" onMouseDown={(e) => e.preventDefault()} onClick={onCancel}>
            Discard
          </button>
        </div>
      ) : (
        <span className="field-note">Ctrl+Enter or click away saves · Esc cancels</span>
      )}
      {edit.error && <div className="modal-error">{edit.error}</div>}
    </div>
  );
}
