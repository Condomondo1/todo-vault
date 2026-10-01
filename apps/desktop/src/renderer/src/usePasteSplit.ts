import { useEffect, useRef, useState } from "react";

import { normalizePaste, remainingAfter, splitPaste } from "./paste";

/**
 * The paste prompt's state, shared by the two boxes that take a note.
 *
 * The paste itself goes through untouched, so the box shows what was pasted. If
 * it qualifies for a question, the box asks once: add the lines as separate
 * notes, or keep them as the one note that is already sitting in the box.
 * Escape and Enter both mean the second. The question goes away by itself if the
 * pasted text is edited out of the box.
 */
export function usePasteSplit({
  draft,
  setDraft,
  addNotes,
}: {
  draft: string;
  setDraft: (next: string) => void;
  /**
   * Add one note per line, last line first. Resolves with how many were saved and
   * an error message, which is null once all are. A failure part-way has still
   * saved some, and the prompt must not offer those again.
   */
  addNotes: (lines: string[]) => Promise<{ saved: number; error: string | null }>;
}) {
  const [pending, setPending] = useState<{ text: string; lines: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The paste event fires before the browser has put the text in the box, so the
  // draft does not hold it yet when the question is first raised. It is only
  // withdrawn once the text has been seen there and is then edited away.
  const inBox = useRef(false);
  useEffect(() => {
    if (!pending) {
      inBox.current = false;
      return;
    }
    if (draft.includes(pending.text)) inBox.current = true;
    else if (inBox.current) setPending(null);
  }, [draft, pending]);

  return {
    /** How many lines are on offer, or null when nothing is being asked. */
    lines: pending?.lines.length ?? null,
    error,
    busy,
    onPaste: (event: React.ClipboardEvent): void => {
      const text = normalizePaste(event.clipboardData.getData("text/plain"));
      const lines = splitPaste(text);
      setError(null);
      setPending(lines ? { text, lines } : null);
    },
    /** Dismiss the question and leave the text as one note. */
    keepOne: (): void => setPending(null),
    /** Turn the pasted lines into notes, and take them out of the box. */
    splitAll: async (): Promise<void> => {
      if (!pending || busy) return;
      setBusy(true);
      const { saved, error: message } = await addNotes(pending.lines);
      setBusy(false);
      if (message) {
        // What was saved stays saved; the question now covers only the rest, so a
        // retry cannot make the same note twice.
        if (saved > 0) setPending({ text: pending.text, lines: remainingAfter(pending.lines, saved) });
        setError(
          saved > 0 ? `${message} (${saved} of ${pending.lines.length} were added.)` : message,
        );
        return;
      }
      setError(null);
      setPending(null);
      // Only what was pasted: anything typed around it stays for the next note.
      const rest = draft.replace(pending.text, "");
      setDraft(rest.trim() === "" ? "" : rest);
    },
    isAsking: pending !== null,
  };
}
