/** The question a multi-line paste asks. Shared by the page's box and the sidebar's. */
export function PastePrompt({
  lines,
  busy,
  error,
  onSplit,
  onKeep,
}: {
  lines: number;
  busy: boolean;
  error: string | null;
  onSplit: () => void;
  onKeep: () => void;
}): React.JSX.Element {
  return (
    <div className="paste-prompt" role="status">
      <span>{lines} lines pasted —</span>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={onSplit}>
        {busy ? "Adding…" : `Add as ${lines} notes`}
      </button>
      <button type="button" className="btn" disabled={busy} onClick={onKeep}>
        Keep as 1 note
      </button>
      <span className="spacer" />
      <span className="paste-prompt-hint">
        <kbd>Esc</kbd> keep as 1
      </span>
      {error && <span className="modal-error paste-prompt-error">{error}</span>}
    </div>
  );
}
