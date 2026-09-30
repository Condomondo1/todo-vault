import { useEffect, useState } from "react";
import type { JiraAuthKind, JiraCredentialInput, JiraStatus, Result } from "@shared/api";

const TOKEN_PAGE = "https://id.atlassian.com/manage-profile/security/api-tokens";

/**
 * Settings → Jira, the connection half: where the credential goes in.
 *
 * Same rule as ClaudeSettings: the token is typed here, sent to main once, and
 * never read back, so this panel can say *that* a credential is stored and for
 * which site and email, never what the token is. Replace re-enters all three
 * fields rather than the token alone, because main stores them as one pair.
 *
 * Test connection, the project picker and the field mapping arrive with the
 * Jira client (slice A of the push plan). Until then a stored credential reads
 * as "not verified yet", which is true, rather than claiming anything about it.
 */
export function JiraSettings({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [status, setStatus] = useState<JiraStatus | null>(null);
  const [entering, setEntering] = useState(false);
  const [draft, setDraft] = useState<JiraCredentialInput>({
    site: "",
    auth: "site",
    email: "",
    token: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void window.vault.jiraStatus().then((result) => {
      if (!live) return;
      if (result.ok) setStatus(result.value);
      else setError(result.message);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** Both mutations answer with a fresh status, so nothing has to re-fetch. */
  const run = async (call: () => Promise<Result<JiraStatus>>): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await call();
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setStatus(result.value);
    setDraft((d) => ({ ...d, token: "" }));
    setEntering(false);
  };

  const credential = status?.credential;
  const showForm = status?.storageAvailable && (!credential || entering);
  const complete = Boolean(draft.site.trim() && draft.email.trim() && draft.token.trim());
  const save = (): void => {
    if (complete && !busy) void run(() => window.vault.setJiraCredentials(draft));
  };

  const set = (patch: Partial<JiraCredentialInput>): void => setDraft((d) => ({ ...d, ...patch }));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-narrow" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Jira</h2>
          <div className="spacer" />
          <button className="btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="modal-body">
          <p className="field-note">
            Connect once, and the app can create issues in one Jira Cloud project from items you
            review first. Nothing is sent from here: this only stores the connection.
          </p>

          {!status && !error && <p className="field-note">Checking…</p>}

          {status && (
            <>
              <div className="claude-state">
                <span
                  className="dot"
                  style={{ background: credential ? "var(--done)" : "var(--todo)" }}
                />
                {!status.storageAvailable
                  ? "Unavailable on this machine"
                  : credential
                    ? `${credential.email} on ${new URL(credential.site).host}`
                    : "Not connected"}
                <span className="spacer" />
                {credential && (
                  <span className="pill" title="When Test connection last succeeded">
                    {credential.verifiedAt
                      ? `verified ${new Date(credential.verifiedAt).toLocaleDateString()}`
                      : "not verified yet"}
                  </span>
                )}
              </div>

              {!status.storageAvailable && (
                <div className="banner banner-warn">
                  <span style={{ flex: 1 }}>
                    {status.reason ??
                      "Encrypted storage is not available, so there is nowhere safe to keep a token."}
                  </span>
                </div>
              )}

              {showForm && (
                <form
                  className="jira-connect"
                  onSubmit={(e) => {
                    e.preventDefault();
                    save();
                  }}
                >
                  <label>
                    <span>Jira site</span>
                    <input
                      value={draft.site}
                      autoFocus
                      placeholder="https://yourcompany.atlassian.net"
                      onChange={(e) => set({ site: e.target.value })}
                    />
                  </label>

                  <fieldset className="jira-auth-kind">
                    <legend>Token kind</legend>
                    {(
                      [
                        ["site", "Classic token", "It can do anything your account can."],
                        [
                          "scoped",
                          "Scoped token",
                          "Recommended. Limited to the scopes you choose when you create it.",
                        ],
                      ] as Array<[JiraAuthKind, string, string]>
                    ).map(([kind, label, note]) => (
                      <label key={kind} className="jira-auth-option">
                        <input
                          type="radio"
                          name="jira-auth"
                          checked={draft.auth === kind}
                          onChange={() => set({ auth: kind })}
                        />
                        <span>
                          {label}
                          <small>{note}</small>
                        </span>
                      </label>
                    ))}
                  </fieldset>

                  <label>
                    <span>Atlassian account email</span>
                    <input
                      type="email"
                      value={draft.email}
                      placeholder="you@yourcompany.com"
                      onChange={(e) => set({ email: e.target.value })}
                    />
                  </label>

                  <label>
                    <span>API token</span>
                    <input
                      type="password"
                      value={draft.token}
                      onChange={(e) => set({ token: e.target.value })}
                    />
                  </label>

                  <p className="field-note">
                    Create one at{" "}
                    <button
                      type="button"
                      className="link-button"
                      onClick={() =>
                        void window.vault.openTarget({ kind: "external", value: TOKEN_PAGE })
                      }
                    >
                      id.atlassian.com
                    </button>
                    . A scoped token needs to read and write Jira work items, and to read users
                    for the assignee search.
                  </p>
                  {/* Submitting from any field, as in every other form here. */}
                  <button type="submit" hidden />
                </form>
              )}

              {status.storageAvailable && (
                <p className="field-note">
                  The token is stored encrypted by the operating system, in the app&rsquo;s own
                  data folder. It is never written to the vault, which is synced and committed to
                  git. It is only ever sent to Atlassian, for the site above.
                </p>
              )}
            </>
          )}

          {error && <div className="modal-error">{error}</div>}
        </div>

        <footer className="modal-foot">
          {credential && !entering && (
            <>
              <button
                className="btn btn-danger"
                disabled={busy}
                onClick={() => void run(() => window.vault.clearJiraCredentials())}
              >
                Remove
              </button>
              <button
                className="btn"
                disabled={busy}
                onClick={() => {
                  // Prefilled but for the token: the three are one pair, and
                  // the token is the one thing this panel never has.
                  setDraft({ site: credential.site, auth: credential.auth, email: credential.email, token: "" });
                  setEntering(true);
                }}
              >
                Replace
              </button>
            </>
          )}
          {entering && (
            <button
              className="btn"
              disabled={busy}
              onClick={() => {
                setEntering(false);
                setError(null);
                setDraft((d) => ({ ...d, token: "" }));
              }}
            >
              Cancel
            </button>
          )}
          {showForm && (
            <button className="btn btn-primary" disabled={busy || !complete} onClick={save}>
              {busy ? "Saving…" : "Save"}
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
