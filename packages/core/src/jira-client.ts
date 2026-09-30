/**
 * The one way this codebase talks to Jira.
 *
 * Every request to Jira — discovery from the CLI, the app's connection check,
 * the field read that drives the mapping editor, and eventually the push —
 * goes through `createJiraClient`. That is the point of the module. The rules
 * below are security rules, and a second fetch path anywhere else would be a
 * second place for each of them to be forgotten.
 *
 * **HTTPS only.** `normaliseBaseUrl` rejects `http:` rather than upgrading it,
 * because Basic auth over plain HTTP is the token in the clear, and a silent
 * upgrade would hide the typo that caused it.
 *
 * **One origin.** A client is built for one site and cannot be handed a full
 * URL: callers pass a path, and a path that would resolve anywhere else is
 * refused before a request is made. Attachment uploads and user searches will
 * go through the same client, so there is nothing to smuggle a URL through.
 *
 * **No redirects followed.** A redirect carrying an `Authorization` header to a
 * different host is the textbook way a token leaks. Atlassian's REST API does
 * not redirect in normal operation, so any 3xx is reported as a failure rather
 * than followed. `redirect: "manual"` rather than `"error"` so the failure can
 * say what happened instead of arriving as an opaque network error.
 *
 * **The token never leaves this file formatted.** It is base64'd into a header
 * inside `request` and nowhere else. `JiraError` carries the status, the path,
 * and Jira's own messages — never a header — and a test feeds failures through
 * and asserts the token appears in none of them.
 *
 * **Expiry is expected.** Atlassian API tokens expire (a year at most, and as
 * little as a day). A 401 on a credential that used to work is the normal way
 * that shows up, so its message says so and says where to fix it.
 */
import { z } from "zod";

/** Whether the token is a classic API token or a scoped one. */
export type JiraAuthKind = "site" | "scoped";

export interface JiraClientOptions {
  /** The Jira site, e.g. `https://acme.atlassian.net`. Always the site, even for scoped tokens. */
  site: string;
  /**
   * `site` (the default) sends requests to the site itself. `scoped` sends them
   * through Atlassian's API gateway, which is where scoped tokens are accepted:
   * `https://api.atlassian.com/ex/jira/{cloudId}`. The site is still needed,
   * both to resolve the cloud id and to build links a person can click.
   */
  auth?: JiraAuthKind;
  /** Required when `auth` is `scoped`. See `resolveCloudId`. */
  cloudId?: string;
  email: string;
  token: string;
  /** Injected in tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Injected in tests so a 429 does not make the suite wait. */
  sleep?: (ms: number) => Promise<void>;
  /** How many times a 429 is retried before it is reported. Default 3. */
  maxRetries?: number;
  /** Told about each 429 wait, so a UI can say "resuming in 12s" rather than looking hung. */
  onRateLimit?: (waitMs: number, attempt: number) => void;
}

/**
 * What went wrong, sorted into the cases a caller does something different
 * about. `message` is written for a person and is safe to show as-is.
 */
export type JiraErrorKind =
  | "auth" // 401: bad, expired or revoked token, or the wrong email for it
  | "forbidden" // 403: the account is real but may not do this
  | "notFound" // 404
  | "rateLimited" // 429 after the retries ran out
  | "redirect" // a 3xx, refused rather than followed
  | "network" // the request never got a response
  | "badResponse" // a 2xx whose body is not the shape we read
  | "http"; // any other non-2xx

export class JiraError extends Error {
  readonly kind: JiraErrorKind;
  readonly status?: number;
  /** The path requested, never the full URL with a query that might carry a name. */
  readonly path: string;
  /** Jira's `errorMessages`, verbatim. */
  readonly jiraMessages: string[];
  /** Jira's `errors` object — field id to message — which is how a create says which field it refused. */
  readonly fieldErrors: Record<string, string>;

  constructor(init: {
    kind: JiraErrorKind;
    message: string;
    path: string;
    status?: number;
    jiraMessages?: string[];
    fieldErrors?: Record<string, string>;
  }) {
    super(init.message);
    this.name = "JiraError";
    this.kind = init.kind;
    this.status = init.status;
    this.path = init.path;
    this.jiraMessages = init.jiraMessages ?? [];
    this.fieldErrors = init.fieldErrors ?? {};
  }
}

/**
 * A pasted site URL, reduced to the origin every request is pinned to.
 *
 * Trailing slashes and whitespace are the common ways a pasted URL differs from
 * a usable one, and a path is the next (`…atlassian.net/jira/software/…`
 * copied from the address bar), so all three are dropped. Anything that is not
 * an `https:` URL is refused, and so is one with a username or password in it,
 * since that is a credential in a field that gets written to `jira-map.yaml`.
 */
export function normaliseBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`"${trimmed}" is not a URL. Use the site address, e.g. https://yourcompany.atlassian.net`);
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `Jira must be reached over https, and "${trimmed}" is ${url.protocol.replace(":", "")}. The token would travel in the clear.`,
    );
  }
  if (url.username || url.password) {
    throw new Error("Leave the username and password out of the site URL; the email and token are entered separately.");
  }
  return url.origin;
}

/** Where requests go: the site for a classic token, the gateway for a scoped one. */
export function apiRoot(options: Pick<JiraClientOptions, "site" | "auth" | "cloudId">): string {
  const site = normaliseBaseUrl(options.site);
  if ((options.auth ?? "site") === "site") return site;
  if (!options.cloudId || !/^[0-9a-f-]{16,64}$/i.test(options.cloudId)) {
    throw new Error("A scoped token needs the site's cloud id. Resolve it from the site first.");
  }
  return `https://api.atlassian.com/ex/jira/${options.cloudId}`;
}

/** The account a credential belongs to — what "Test connection" shows back. */
export interface JiraMyself {
  accountId: string;
  displayName: string;
  emailAddress?: string;
}

const MyselfResponse = z.object({
  accountId: z.string(),
  displayName: z.string(),
  emailAddress: z.string().optional(),
});

const ErrorBody = z
  .object({
    errorMessages: z.array(z.string()).optional(),
    errors: z.record(z.string()).optional(),
  })
  .passthrough();

export interface JiraClient {
  /** The origin plus prefix every request is pinned under. */
  readonly root: string;
  /** The site, for building links a person can open. */
  readonly site: string;
  get(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  put(path: string, body: unknown): Promise<unknown>;
  /** `GET /rest/api/3/myself` — proves the credential and names its owner. */
  myself(): Promise<JiraMyself>;
}

export function createJiraClient(options: JiraClientOptions): JiraClient {
  const root = apiRoot(options);
  const site = normaliseBaseUrl(options.site);
  const rootUrl = new URL(root);
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = options.maxRetries ?? 3;

  if (!options.email.trim() || !options.token.trim()) {
    throw new Error("A Jira connection needs both the account email and an API token.");
  }

  /** Resolve a caller's path under the root, refusing anything that escapes it. */
  function resolve(path: string, query?: Record<string, string | number | boolean | undefined>): URL {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("://") || path.includes("..")) {
      throw new Error(`Refusing to request "${path}": a Jira client takes a path under its own site, not a URL.`);
    }
    const url = new URL(`${root}${path}`);
    if (url.origin !== rootUrl.origin || !url.pathname.startsWith(rootUrl.pathname)) {
      throw new Error(`Refusing to request "${path}": it resolves outside ${root}.`);
    }
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  async function request(method: "GET" | "POST" | "PUT", path: string, init: { body?: unknown; query?: Record<string, string | number | boolean | undefined> } = {}): Promise<unknown> {
    const url = resolve(path, init.query);
    // Basic over email:token is what Jira Cloud accepts for an API token,
    // classic or scoped; there is no bearer form. Formatted here and only here.
    const authorization = `Basic ${Buffer.from(`${options.email.trim()}:${options.token.trim()}`).toString("base64")}`;

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await doFetch(url, {
          method,
          redirect: "manual",
          headers: {
            Authorization: authorization,
            Accept: "application/json",
            ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        });
      } catch (err) {
        throw new JiraError({
          kind: "network",
          path,
          message: `Could not reach ${rootUrl.host}. ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      if (response.status === 429 && attempt < maxRetries) {
        const wait = retryAfterMs(response.headers.get("retry-after"), attempt);
        options.onRateLimit?.(wait, attempt + 1);
        await sleep(wait);
        continue;
      }

      if (response.status >= 300 && response.status < 400) {
        throw new JiraError({
          kind: "redirect",
          status: response.status,
          path,
          message: `Jira answered ${path} with a redirect (${response.status}), which is refused rather than followed so the token cannot be sent anywhere else. Check the site URL is the Jira site itself.`,
        });
      }

      if (!response.ok) throw await errorFor(response, path);

      if (response.status === 204) return undefined;
      const text = await response.text();
      if (!text) return undefined;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new JiraError({
          kind: "badResponse",
          status: response.status,
          path,
          message: `Jira answered ${path} with something that is not JSON. Check the site URL points at Jira.`,
        });
      }
    }
  }

  return {
    root,
    site,
    get: (path, query) => request("GET", path, { query }),
    post: (path, body) => request("POST", path, { body }),
    put: (path, body) => request("PUT", path, { body }),
    async myself() {
      return parseOrThrow(MyselfResponse, await request("GET", "/rest/api/3/myself"), "/rest/api/3/myself");
    },
  };
}

/**
 * How long to wait before retrying a 429. Jira sends `Retry-After` in seconds;
 * without it, back off exponentially from one second. Capped at a minute so a
 * nonsense header cannot park the app for an hour.
 */
export function retryAfterMs(header: string | null, attempt: number): number {
  const seconds = header === null ? Number.NaN : Number(header);
  const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000 * 2 ** attempt;
  return Math.min(ms, 60_000);
}

async function errorFor(response: Response, path: string): Promise<JiraError> {
  let jiraMessages: string[] = [];
  let fieldErrors: Record<string, string> = {};
  try {
    const parsed = ErrorBody.safeParse(JSON.parse(await response.text()));
    if (parsed.success) {
      jiraMessages = parsed.data.errorMessages ?? [];
      fieldErrors = parsed.data.errors ?? {};
    }
  } catch {
    // Not JSON — an HTML error page from a proxy, usually. The status says enough.
  }

  const detail = [
    ...jiraMessages,
    ...Object.entries(fieldErrors).map(([field, message]) => `${field}: ${message}`),
  ].join(" ");
  const said = detail ? ` Jira said: ${detail}` : "";
  const base = { status: response.status, path, jiraMessages, fieldErrors };

  switch (response.status) {
    case 401:
      return new JiraError({
        ...base,
        kind: "auth",
        message:
          "Jira rejected the stored token — it may have expired or been revoked, or belong to a different email. Create a new API token at id.atlassian.com and replace it in Settings → Jira.",
      });
    case 403:
      return new JiraError({
        ...base,
        kind: "forbidden",
        message: `The account reached Jira but is not allowed to do this (${path}). Check its project permissions, or the scopes on a scoped token.${said}`,
      });
    case 404:
      return new JiraError({
        ...base,
        kind: "notFound",
        message: `Jira has nothing at ${path}. Check the project key, and that the account can see the project.${said}`,
      });
    case 429:
      return new JiraError({
        ...base,
        kind: "rateLimited",
        message: "Jira is rate-limiting these requests and kept doing so after several waits. Try again in a few minutes.",
      });
    default:
      return new JiraError({
        ...base,
        kind: "http",
        message: `Jira answered ${path} with ${response.status}.${said}`,
      });
  }
}

/** Parse a response against the shape we read, so a changed API fails here and says where. */
export function parseOrThrow<S extends z.ZodTypeAny>(schema: S, value: unknown, path: string): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new JiraError({
      kind: "badResponse",
      path,
      message: `Jira's answer to ${path} was not the shape expected (${parsed.error.issues[0]?.path.join(".") || "root"}: ${parsed.error.issues[0]?.message}). The API may have changed.`,
    });
  }
  return parsed.data;
}

const TenantInfo = z.object({ cloudId: z.string().min(1) });

/**
 * A site's cloud id, which scoped tokens need to address the API gateway.
 *
 * `/_edge/tenant_info` is unauthenticated on purpose — it is how a client finds
 * the id before it has anywhere to send credentials — so no token is sent here
 * at all. Same https and no-redirect rules as the client.
 */
export async function resolveCloudId(site: string, doFetch: typeof fetch = fetch): Promise<string> {
  const origin = normaliseBaseUrl(site);
  const path = "/_edge/tenant_info";
  let response: Response;
  try {
    response = await doFetch(`${origin}${path}`, { redirect: "manual", headers: { Accept: "application/json" } });
  } catch (err) {
    throw new JiraError({
      kind: "network",
      path,
      message: `Could not reach ${new URL(origin).host}. ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  if (!response.ok) {
    throw new JiraError({
      kind: response.status >= 300 && response.status < 400 ? "redirect" : "http",
      status: response.status,
      path,
      message: `${new URL(origin).host} did not report a cloud id (${response.status}). Check it is a Jira Cloud site.`,
    });
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return parseOrThrow(TenantInfo, body, path).cloudId;
}
