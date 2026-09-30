/**
 * The Jira credential's shape, and the checks made before one is stored.
 *
 * Pure, with no Electron import, so it can be tested directly. The storage
 * itself is `secrets.ts`, under the name "jira".
 *
 * **One blob, not three secrets.** The email is not secret, but it is stored
 * encrypted beside the token so the pair can never disagree: replacing one
 * means re-entering the other, which removes the "right token, stale email"
 * 401. The site goes in the same blob for the same reason. A token is issued
 * for a site, and a credential with no record of which site it belongs to
 * could be sent to any site a map happens to name.
 */

import {
  createJiraClient,
  normaliseBaseUrl,
  resolveCloudId,
  type JiraMyself,
} from "todo-vault";

import type {
  JiraAuthKind,
  JiraCredentialInput,
  JiraCredentialSummary,
} from "../shared/api.js";

/** What is encrypted into `jira-credentials.bin`. Main process only. */
export interface StoredJiraCredential {
  /** Bumped if the shape ever changes, so an old blob is recognised rather than misread. */
  v: 1;
  /** `https://<name>.atlassian.net`: an origin, no path, never `http:`. */
  site: string;
  /**
   * A classic API token authenticates against the site itself. A scoped token
   * is addressed through `api.atlassian.com/ex/jira/{cloudId}`. Same Basic
   * header either way, different base URL, so the kind has to be remembered.
   */
  auth: JiraAuthKind;
  email: string;
  token: string;
  /**
   * The site's cloud id, resolved once for a scoped token and kept, since the
   * gateway URL needs it on every request and it never changes for a site.
   */
  cloudId?: string;
  /** Set by a successful Test connection. Absent until one has run. */
  verifiedAt?: string;
  /** Whose account the token proved to be, as Jira names it. Not a secret. */
  accountName?: string;
}

/**
 * The site a person typed, reduced to an origin.
 *
 * The rules are the core's `normaliseBaseUrl`, the same function the Jira
 * client checks every request with, so a site this accepts is one the client
 * will accept, and there is only one place those rules can change: `http:` is
 * refused rather than upgraded, credentials in the URL are refused, and a
 * pasted board URL keeps only its origin. The two additions here are for the
 * settings field alone. An empty field gets a prompt instead of a URL error,
 * and a bare host gets `https://`, since that is what nearly everyone means by
 * `acme.atlassian.net`.
 */
export function parseJiraSite(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Enter your Jira site, such as https://yourcompany.atlassian.net.");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return normaliseBaseUrl(withScheme);
}

/** Validates and normalises what the settings panel sends. Throws a message for a person. */
export function toStoredCredential(input: JiraCredentialInput): StoredJiraCredential {
  const site = parseJiraSite(input.site);
  if (input.auth !== "site" && input.auth !== "scoped") {
    throw new Error("Choose which kind of API token this is.");
  }
  const email = input.email.trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new Error(`${email || "An empty email"} is not an email address.`);
  }
  // Tokens are opaque, so the only check is that one was pasted. Internal
  // whitespace is kept: trimming the ends catches a stray copied newline,
  // and anything more would be guessing at a format Atlassian can change.
  const token = input.token.trim();
  if (!token) throw new Error("Paste the API token.");
  return { v: 1, site, auth: input.auth, email, token };
}

/**
 * The stored blob read back. Null for anything that is not a version-1
 * credential: a blob this code cannot read is treated like one it cannot
 * decrypt, which `secrets.ts` already counts as no credential at all.
 */
export function parseStoredCredential(raw: string | null): StoredJiraCredential | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredJiraCredential>;
    if (
      value.v !== 1 ||
      typeof value.site !== "string" ||
      (value.auth !== "site" && value.auth !== "scoped") ||
      typeof value.email !== "string" ||
      typeof value.token !== "string" ||
      !value.token
    ) {
      return null;
    }
    return {
      v: 1,
      site: value.site,
      auth: value.auth,
      email: value.email,
      token: value.token,
      ...(typeof value.cloudId === "string" ? { cloudId: value.cloudId } : {}),
      ...(typeof value.verifiedAt === "string" ? { verifiedAt: value.verifiedAt } : {}),
      ...(typeof value.accountName === "string" ? { accountName: value.accountName } : {}),
    };
  } catch {
    return null;
  }
}

/** The token removed, by construction rather than by remembering to delete it. */
export function summarise(stored: StoredJiraCredential): JiraCredentialSummary {
  return {
    site: stored.site,
    auth: stored.auth,
    email: stored.email,
    ...(stored.verifiedAt ? { verifiedAt: stored.verifiedAt } : {}),
    ...(stored.accountName ? { accountName: stored.accountName } : {}),
  };
}

/**
 * Prove the pair by asking Jira who it belongs to (`GET /rest/api/3/myself`),
 * and return the credential stamped with the answer.
 *
 * Everything that talks to Jira is the core's client. This only decides what
 * to ask it and what to keep. For a scoped token the cloud id is resolved
 * first, unauthenticated, and kept, so the next check does not repeat it.
 * Failures are the client's `JiraError`, whose message is written for a
 * person and never contains the token, so they reach the panel unchanged.
 */
export async function verifyCredential(
  stored: StoredJiraCredential,
  deps: { fetch?: typeof fetch; now?: () => Date } = {},
): Promise<{ stored: StoredJiraCredential; account: JiraMyself }> {
  const cloudId =
    stored.auth === "scoped"
      ? (stored.cloudId ?? (await resolveCloudId(stored.site, deps.fetch)))
      : undefined;
  const client = createJiraClient({
    site: stored.site,
    auth: stored.auth,
    cloudId,
    email: stored.email,
    token: stored.token,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  const account = await client.myself();
  return {
    stored: {
      ...stored,
      ...(cloudId ? { cloudId } : {}),
      verifiedAt: (deps.now?.() ?? new Date()).toISOString(),
      accountName: account.displayName,
    },
    account,
  };
}

/**
 * A refusal on first Connect, said as one.
 *
 * The client's 401 message talks about "the stored token", which is right for
 * Test connection and for a push, where a token that used to work has expired.
 * On Connect nothing is stored yet, and the likelier cause is a token pasted
 * short or an email that is not its owner's. Every other failure (network,
 * redirect, forbidden) already reads correctly and passes through unchanged.
 */
export function forFirstConnect(err: unknown): unknown {
  if ((err as { kind?: unknown } | null)?.kind !== "auth") return err;
  return new Error(
    "Jira did not accept this email and token. Check that the whole token was pasted, that it " +
      "was created by this email's account, and that it has not expired.",
  );
}
