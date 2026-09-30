import { useEffect, useState } from "react";
import type { JiraAuthKind, JiraCredentialInput, JiraStatus, Result } from "@shared/api";

import { JiraMapping } from "./JiraMapping";

const TOKEN_PAGE = "https://id.atlassian.com/manage-profile/security/api-tokens";

/**
 * Settings → Jira: two tabs, Connection (here) and Mapping (JiraMapping.tsx).
 * They are tabs rather than one long panel so that each stays short: the
 * connection is set once, and the mapping is revisited as the project changes.
 *
 * Connection is where the credential goes in.
 *
 * Same rule as ClaudeSettings: the token is typed here, sent to main once, and
 * never read back, so this panel can say *that* a credential is stored and for
 * which site and email, never what the token is. Replace re-enters all three
 * fields rather than the token alone, because main stores them as one pair.
 *
 * Connect asks Jira who the pair belongs to before anything is stored, so a
 * saved credential is one that worked at least once. Test connection asks
 * again later, because tokens expire, and an expired one should show up here
 * rather than halfway through a push.
 */
export function JiraSettings({
  onClose,
  vaultPeople,
}: {
  onClose: () => void;
  /** The vault's assignees, one spelling each, for Mapping's People section. */
  vaultPeople: string[];
}): React.JSX.Element {
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
  /** Which action is in flight, so the right button says what it is waiting on. */
  const [pending, setPending] = useState<"connect" | "test" | "remove" | null>(null);
  /** A short confirmation after a Test connection that passed. */
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [tab, setTab] = useState<"connection" | "mapping">("connection");

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
  const run = async (
    which: "connect" | "test" | "remove",
    call: () => Promise<Result<JiraStatus>>,
  ): Promise<void> => {
    setBusy(true);
    setPending(which);
    setError(null);
    setConfirmed(null);
    const result = await call();
    setBusy(false);
    setPending(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setStatus(result.value);
    setDraft((d) => ({ ...d, token: "" }));
    setEntering(false);
    if (which === "test") setConfirmed("Jira accepted the stored token.");
  };

  const credential = status?.credential;
  const showForm = status?.storageAvailable && (!credential || entering);
  // Mapping reads the project with the stored credential, so it needs one, and
  // not one half-replaced: while Replace is open the panel is about the pair.
  const mappingAvailable = Boolean(credential) && !entering;
  const shown = mappingAvailable ? tab : "connection";
  const complete = Boolean(draft.site.trim() && draft.email.trim() && draft.token.trim());
  const save = (): void => {
    if (complete && !busy) void run("connect", () => window.vault.setJiraCredentials(draft));
  };

  const set = (patch: Partial<JiraCredentialInput>): void => setDraft((d) => ({ ...d, ...patch }));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-jira" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Jira</h2>
          <div className="tabs jira-tabs" role="tablist">
            {(
              [
                ["connection", "Connection"],
                ["mapping", "Mapping"],
              ] as const
            ).map(([which, label]) => (
              <button
                key={which}
                role="tab"
                className="tab"
                aria-selected={shown === which}
                disabled={which === "mapping" && !mappingAvailable}
                title={which === "mapping" && !credential ? "Connect first" : undefined}
                onClick={() => setTab(which)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="spacer" />
          <button className="btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="modal-body">
          {/*
            Kept mounted while hidden, so a project loaded on Mapping is still
            there after a look at Connection. Mounted only with a credential,
            since everything it does asks Jira.
          */}
          {credential && (
            <div role="tabpanel" aria-label="Mapping" className="jira-tabpanel" hidden={shown !== "mapping"}>
              <JiraMapping vaultPeople={vaultPeople} />
            </div>
          )}

          <div role="tabpanel" aria-label="Connection" className="jira-tabpanel" hidden={shown !== "connection"}>
            <p className="field-note">
              Connect once, and the app can create issues in one Jira Cloud project from items you
              review first. Connecting only asks Jira whose token this is; nothing about your items
              is sent from here.
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
                      ? `${credential.accountName ? `${credential.accountName} · ` : ""}${credential.email} on ${new URL(credential.site).host}`
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

            {confirmed && <p className="field-note jira-confirmed">{confirmed}</p>}
            {error && <div className="modal-error">{error}</div>}
          </div>
        </div>

        <footer className="modal-foot">
          {credential && !entering && shown === "connection" && (
            <>
              <button
                className="btn btn-danger"
                disabled={busy}
                onClick={() => void run("remove", () => window.vault.clearJiraCredentials())}
              >
                Remove
              </button>
              <button
                className="btn"
                disabled={busy}
                onClick={() => void run("test", () => window.vault.testJiraConnection())}
              >
                {pending === "test" ? "Asking Jira…" : "Test connection"}
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
              {pending === "connect" ? "Asking Jira…" : "Connect"}
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
