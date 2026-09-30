/**
 * A stand-in for `fetch` that records every request and answers from a script,
 * so the Jira client's rules can be tested without a Jira.
 *
 * Not a test file itself (no `.test.` in the name, so the glob skips it). It is
 * shared by `jira-client.test.ts` and `jira-meta.test.ts`.
 */

export interface RecordedRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  redirect?: RequestRedirect;
  body?: unknown;
}

/** A canned answer: a status and a JSON body, or a function of the request. */
export type Reply =
  | { status: number; json?: unknown; text?: string; headers?: Record<string, string> }
  | ((req: RecordedRequest) => { status: number; json?: unknown; text?: string; headers?: Record<string, string> });

export interface FakeFetch {
  fetch: typeof fetch;
  requests: RecordedRequest[];
}

/**
 * Answers by matching `METHOD pathname` (query ignored) against `routes`, in
 * order; an array of replies is consumed one per call, the last one repeating.
 * A request that matches nothing is a test failure, answered with a 599 that
 * no code path treats as success.
 */
export function fakeFetch(routes: Record<string, Reply | Reply[]>): FakeFetch {
  const requests: RecordedRequest[] = [];
  const cursors = new Map<string, number>();

  const impl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const req: RecordedRequest = {
      url,
      method: init.method ?? "GET",
      headers,
      redirect: init.redirect,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(req);

    const key = `${req.method} ${url.pathname}`;
    const route = routes[key];
    if (!route) return new Response(`no route for ${key}`, { status: 599 });

    let reply: Reply;
    if (Array.isArray(route)) {
      const i = cursors.get(key) ?? 0;
      cursors.set(key, i + 1);
      reply = route[Math.min(i, route.length - 1)];
    } else {
      reply = route;
    }
    const r = typeof reply === "function" ? reply(req) : reply;
    const body = r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? null);
    // A Response cannot carry a body on a null-body status.
    const nullBody = r.status === 204 || (r.status >= 300 && r.status < 400);
    return new Response(nullBody ? null : body, {
      status: r.status,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  };

  return { fetch: impl as typeof fetch, requests };
}
