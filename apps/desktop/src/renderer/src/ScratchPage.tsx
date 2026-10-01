import { useEffect, useRef, useState } from "react";
import type { ScratchNote } from "todo-vault";

import { Markdown } from "./Markdown";
import { shortAge } from "./scratch";

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
          onKeyDown={(e) => {
            // Nothing typed here may reach the window's bare-key shortcuts.
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.currentTarget.blur();
              if (selectedId === null && notes.length > 0) onSelect(notes[0].id);
            }
          }}
        />
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
