/**
 * A fake Anthropic API for the e2e specs: plain HTTP on 127.0.0.1.
 *
 * The SDK in the main process reads `ANTHROPIC_BASE_URL` when it builds its
 * client, and the harness passes `env` through to the app, so pointing that at
 * this server is all it takes for `draftItem` to talk to it. No TLS is needed,
 * unlike the fake Jira, because the SDK takes the base URL as given.
 *
 * Only `POST /v1/messages` is answered, with a message whose single text block
 * is the draft as JSON, which is the shape `draftItem` asks the real API for.
 * Every request is recorded, so a spec can say both what was sent and that
 * nothing was sent until it should have been.
 *
 * A spec using this must call `assertLocalBaseUrl` before it stores a key or
 * clicks anything that drafts. A stored key plus a base URL that did not reach
 * the app would be a real, billed call to the real API.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

import type { ElectronApplication } from "playwright-core";

export interface FakeClaudeRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: {
    model?: string;
    system?: string;
    messages?: Array<{ role: string; content: string }>;
  };
}

/** What the model "replied": the draft's fields, as the schema names them. */
export type FakeDraft = Record<string, unknown>;

type Reply = { status?: number; draft?: FakeDraft; error?: { type: string; message: string }; delayMs?: number };

export interface FakeClaude {
  /** `http://127.0.0.1:<port>`, the value for `ANTHROPIC_BASE_URL`. */
  baseUrl: string;
  /** Everything received, in order. */
  requests: FakeClaudeRequest[];
  /** What the next requests get, until replaced. The default is a plain task draft. */
  reply(next: Reply | ((request: FakeClaudeRequest) => Reply)): void;
  close(): Promise<void>;
}

/** A draft that passes the core's CreateItemInput, for specs that do not care about it. */
export const DEFAULT_DRAFT: FakeDraft = {
  project: "ACME",
  type: "task",
  summary: "A drafted item",
  description: "",
  priority: "medium",
  category: "",
  labels: [],
  dueDate: "",
  cadence: "none",
  reporter: "",
  notes: "",
};

export async function startFakeClaude(): Promise<FakeClaude> {
  const requests: FakeClaudeRequest[] = [];
  let current: Reply | ((request: FakeClaudeRequest) => Reply) = { draft: DEFAULT_DRAFT };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: FakeClaudeRequest["body"] = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as FakeClaudeRequest["body"];
      } catch {
        /* recorded as an empty body */
      }
      const request: FakeClaudeRequest = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body };
      requests.push(request);

      const reply = typeof current === "function" ? current(request) : current;
      const send = (): void => {
        if (request.method !== "POST" || !request.path.startsWith("/v1/messages")) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "not here" } }));
          return;
        }
        if (reply.error) {
          res.writeHead(reply.status ?? 401, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: reply.error }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_fake",
            type: "message",
            role: "assistant",
            model: request.body.model ?? "fake",
            content: [{ type: "text", text: JSON.stringify(reply.draft ?? DEFAULT_DRAFT) }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    reply: (next) => {
      current = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * Throws unless the app's main process will send Anthropic requests to this
 * machine. Run it before a key is stored: the one thing worse than a failing
 * test here is a passing one that spent real money.
 */
export async function assertLocalBaseUrl(app: ElectronApplication, expected: string): Promise<void> {
  const seen = await app.evaluate(() => process.env.ANTHROPIC_BASE_URL ?? "");
  if (seen !== expected || !/^http:\/\/127\.0\.0\.1:\d+$/.test(seen)) {
    throw new Error(
      `Refusing to continue: the app's ANTHROPIC_BASE_URL is ${JSON.stringify(seen)}, not the fake server at ` +
        `${expected}. A stored key would be sent to the real Anthropic API.`,
    );
  }
}
