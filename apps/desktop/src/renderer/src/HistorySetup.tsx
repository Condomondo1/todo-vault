import { useState } from "react";
import type { GitStatus, TurnOnHistoryOptions, TurnOnHistoryResult } from "todo-vault";

const GIT_DOWNLOAD = "https://git-scm.com/downloads";

/**
 * The controls on the "no undo history" banner.
 *
 * The banner already had the diagnosis right: not a repo, a repo that ignores
 * the vault, or a repo whose last commit failed. This adds something to click,
 * except in the two cases IDEAS.md said to explain rather than act. With no git
 * there is nothing a button could do. An ignoring outer repo gets a button, but
 * one worded as the choice it is, never a plain "Fix".
 *
 * The form for name and email only appears once main has checked and found no
 * identity. Asking up front would ask everyone who already has one configured.
 */
export function HistorySetup({
  git,
  busy,
  turnOnHistory,
}: {
  git: GitStatus;
  busy: boolean;
  turnOnHistory: (
    options: TurnOnHistoryOptions,
  ) => Promise<{ error: string | null; result: TurnOnHistoryResult | null }>;
}): React.JSX.Element {
  const [askIdentity, setAskIdentity] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Set once the user has seen the nesting explained and chosen to go ahead. */
  const [nestedRoot, setNestedRoot] = useState<string | null>(null);

  if (!git.gitAvailable) {
    return (
      <div className="history-setup">
        <button
          className="btn"
          onClick={() => void window.vault.openTarget({ kind: "external", value: GIT_DOWNLOAD })}
        >
          Get git
        </button>
        <span className="history-setup-note">then restart the app, so it can find it</span>
      </div>
    );
  }

  const nested = git.ignored || nestedRoot !== null;

  const attempt = async (withIdentity: boolean): Promise<void> => {
    setError(null);
    const { error: failed, result } = await turnOnHistory({
      ...(withIdentity ? { identity: { name, email } } : {}),
      ...(nested ? { allowNested: true } : {}),
    });
    if (failed) {
      setError(failed);
      return;
    }
    if (result?.outcome === "needs-identity") setAskIdentity(true);
    // Only reachable if the repo around the vault changed after this banner
    // rendered. Explain it here, and let the next click be the choice.
    if (result?.outcome === "nested") setNestedRoot(result.repoRoot);
    // `done` needs nothing: the snapshot it came with is healthy, and the
    // banner holding this component goes away.
  };

  return (
    <div className="history-setup">
      {askIdentity ? (
        <form
          className="history-setup-form"
          onSubmit={(e) => {
            e.preventDefault();
            void attempt(true);
          }}
        >
          <span className="history-setup-note">Git needs to know who is making the commits:</span>
          <input
            aria-label="Name for commits"
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            required
          />
          <input
            aria-label="Email for commits"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <button className="btn btn-primary" type="submit" disabled={busy}>
            Turn on history
          </button>
          <button className="btn" type="button" onClick={() => setAskIdentity(false)} disabled={busy}>
            Cancel
          </button>
        </form>
      ) : (
        <button className="btn btn-primary" onClick={() => void attempt(false)} disabled={busy}>
          {nested ? "Keep a separate history here" : "Turn on history"}
        </button>
      )}
      {nestedRoot && !git.ignored && (
        <span className="history-setup-note">
          <code>{nestedRoot}</code> ignores this folder, so this would start a second repository
          inside it.
        </span>
      )}
      {error && <span className="history-setup-error">{error}</span>}
    </div>
  );
}
