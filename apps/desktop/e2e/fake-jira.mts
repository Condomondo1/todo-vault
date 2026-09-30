/**
 * A fake Jira Cloud for the e2e specs: a real HTTPS server on 127.0.0.1.
 *
 * Real Jira appears in no automated test (see plans/PLAN-jira-push.md), and the
 * app's client refuses anything but https, so this has to speak TLS. It gets a
 * throwaway self-signed certificate made with `openssl` at start. The app
 * trusts it through `NODE_EXTRA_CA_CERTS`, passed with the harness's `env`
 * option: Electron's main-process `fetch` reads that variable like any Node
 * process does. That was checked before this was written, not assumed.
 *
 * Every request must carry the Basic credentials it was started with, or it
 * gets a 401 in Jira's own error shape. So a spec that passes is also one
 * where the app sent the right pair. `GET /rest/api/3/myself` is served out of
 * the box. Anything else is a `route()` a spec adds.
 *
 * Only a classic token can be faked. A scoped token is addressed through
 * `api.atlassian.com`, a fixed host this cannot stand in for, so that path is
 * unit-tested over a fake `fetch` instead.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface FakeJiraRequest {
  method: string;
  path: string;
  /** Whether the Basic credentials matched. A 401 was sent when they did not. */
  authorized: boolean;
  body: string;
}

type Handler = (
  req: FakeJiraRequest,
) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;

export interface FakeJira {
  /** `https://localhost:<port>`, the value to type into the Jira site field. */
  site: string;
  /** Pass as `NODE_EXTRA_CA_CERTS` so the app trusts this server. */
  caCertPath: string;
  /** Everything received, in order, including refused requests. */
  requests: FakeJiraRequest[];
  /** Answer `method path` (path without query) with this handler. Replaces any earlier route. */
  route(method: string, path: string, handler: Handler): void;
  close(): Promise<void>;
}

/** Whether a fake Jira can be started here at all: it needs `openssl` to make its certificate. */
export async function canStartFakeJira(): Promise<boolean> {
  try {
    await execFileAsync("openssl", ["version"]);
    return true;
  } catch {
    return false;
  }
}

export async function startFakeJira(options: {
  email: string;
  token: string;
  account?: { accountId: string; displayName: string; emailAddress?: string };
}): Promise<FakeJira> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "todo-vault-e2e-jira-"));
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  // MSYS_NO_PATHCONV: from Git Bash, "/CN=localhost" is otherwise rewritten
  // into a Windows path and openssl refuses the subject.
  await execFileAsync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout", keyPath, "-out", certPath,
    ],
    { env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
  );

  const expected = `Basic ${Buffer.from(`${options.email}:${options.token}`).toString("base64")}`;
  const account = options.account ?? {
    accountId: "5b10ac8d82e05b22cc7d4ef5",
    displayName: "Fake Jira User",
    emailAddress: options.email,
  };
  const requests: FakeJiraRequest[] = [];
  const routes = new Map<string, Handler>();
  routes.set("GET /rest/api/3/myself", () => ({ body: account }));

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = https.createServer(
    { key: await fs.readFile(keyPath), cert: await fs.readFile(certPath) },
    (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const pathOnly = (req.url ?? "/").split("?")[0]!;
        const record: FakeJiraRequest = {
          method: req.method ?? "GET",
          path: pathOnly,
          authorized: req.headers.authorization === expected,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        requests.push(record);
        if (!record.authorized) {
          send(res, 401, { errorMessages: ["Client must be authenticated to access this resource."], errors: {} });
          return;
        }
        const handler = routes.get(`${record.method} ${pathOnly}`);
        if (!handler) {
          send(res, 404, { errorMessages: [`The fake Jira has no route for ${record.method} ${pathOnly}.`], errors: {} });
          return;
        }
        void Promise.resolve(handler(record)).then(
          (out) => send(res, out.status ?? 200, out.body),
          (err: unknown) => send(res, 500, { errorMessages: [String(err)], errors: {} }),
        );
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };

  return {
    site: `https://localhost:${port}`,
    caCertPath: certPath,
    requests,
    route: (method, routePath, handler) => routes.set(`${method.toUpperCase()} ${routePath}`, handler),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
