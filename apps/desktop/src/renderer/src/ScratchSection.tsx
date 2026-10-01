import { useEffect, useRef, useState } from "react";
import type { ScratchNote } from "todo-vault";

import { SIDEBAR_NOTES, firstLine, noteCount, shortAge } from "./scratch";

/**
 * The sidebar's Scratch section, built like Projects: a header with the count and
 * a "+ new", the newest few notes as one-line rows, then "More…" to the page.
 *
 * It is on every view, because jotting something down should not mean leaving
 * what you are doing. Quick-add lives here: Enter adds and keeps the box open
 * for the next one, Escape closes it. The box stops its own keys from reaching
 * the window handler, so a bare `j` typed into it is a "j".
 */
export function ScratchSection({
  notes,
  onPage,
  selectedId,
  adding,
  onAddingChange,
  onAdd,
  onOpenNote,
  onMore,
  onNew,
}: {
  /** Every note, newest first. */
  notes: ScratchNote[];
  /** Whether the Scratch page is the current view. */
  onPage: boolean;
  /** The page's selected note; only meaningful while `onPage`. */
  selectedId: string | null;
  adding: boolean;
  onAddingChange: (adding: boolean) => void;
  /** Resolves to an error message, or null once the note is saved. */
  onAdd: (text: string) => Promise<string | null>;
  onOpenNote: (id: string) => void;
  onMore: () => void;
  /** The "+ new" button. On the page itself App focuses the page's own box. */
  onNew: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const latest = notes.slice(0, SIDEBAR_NOTES);
  const hidden = notes.length - latest.length;
  // More is the way to the page, so it shows whenever there is a page worth
  // opening, and is the highlighted row when the open note is not one of the five.
  const moreCurrent = onPage && !latest.some((note) => note.id === selectedId);
  const now = new Date();

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (!text) return;
    const message = await onAdd(text);
    if (message) {
      setError(message);
      return;
    }
    setError(null);
    setDraft("");
  };

  return (
    <section className="sb-scratch" aria-label="Scratch">
      <div className="sidebar-head">
        <span className="sidebar-title">Scratch</span>
        <span className="project-count" style={{ marginLeft: "auto" }}>
          {noteCount(notes.length)}
        </span>
        <button className="add-btn" onClick={onNew} title="Jot a note (Shift+N)">
          + new
        </button>
      </div>

      {adding && (
        <div className="sb-add">
          <input
            ref={inputRef}
            value={draft}
            placeholder="Jot it down… Enter to add, Esc to close"
            aria-label="New scratch note"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Nothing typed here may reach the window's bare-key shortcuts.
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              } else if (e.key === "Escape") {
                setError(null);
                onAddingChange(false);
              }
            }}
          />
          {error && <div className="sb-error">{error}</div>}
        </div>
      )}

      <div className="sb-notes">
        {latest.length === 0 ? (
          <div className="sb-empty">
            Nothing jotted down. <b>+ new</b> to start.
          </div>
        ) : (
          latest.map((note) => (
            <button
              key={note.id}
              className="project scratch-row"
              aria-current={onPage && note.id === selectedId}
              title={note.text}
              onClick={() => onOpenNote(note.id)}
            >
              <span className="project-name">{firstLine(note.text)}</span>
              <span className="project-count">{shortAge(note.created, now)}</span>
            </button>
          ))
        )}
        {(notes.length > 0 || onPage) && (
          <button className="project sb-more" aria-current={moreCurrent} onClick={onMore}>
            <span className="project-name">{hidden > 0 ? `${hidden} more…` : "More…"}</span>
            <span className="project-count" title="Scratch (6)">
              6
            </span>
          </button>
        )}
      </div>
    </section>
  );
}
