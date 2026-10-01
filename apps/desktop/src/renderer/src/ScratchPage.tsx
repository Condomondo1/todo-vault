import { useEffect, useRef, useState } from "react";
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
 */
export function ScratchPage({
  notes,
  selectedId,
  focusToken,
  onSelect,
  onAdd,
  onAddMany,
  onRemove,
  onOpenLink,
}: {
  notes: ScratchNote[];
  selectedId: string | null;
  /** A new number asks for the capture box to take focus; null leaves it alone. */
  focusToken: number | null;
  onSelect: (id: string | null) => void;
  /** Resolves to an error message, or null once the note is saved. */
  onAdd: (text: string) => Promise<string | null>;
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

  const paste = usePasteSplit({ draft, setDraft, addNotes: onAddMany });

  /** Empties the box as the note is sent, as the sidebar's does; see ScratchSection. */
  const submit = async (): Promise<void> => {
    if (!draft.trim()) return;
    const text = draft;
    setDraft("");
    const message = await onAdd(text);
    if (message) {
      setError(message);
      setDraft((current) => (current === "" ? text : current));
      return;
    }
    setError(null);
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
            // Ctrl+Enter adds too, since it is what saves everywhere else.
            if (e.key === "Enter" && !e.shiftKey) {
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
            >
              <div>
                <div className="scratch-text prose">
                  <Markdown source={note.text} onOpenLink={onOpenLink} />
                </div>
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
