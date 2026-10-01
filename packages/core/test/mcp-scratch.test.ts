import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { Vault } from "../src/vault.js";

/**
 * The scratch tools, driven through a real stdio MCP session against the
 * server's source, the way a Claude client would call them.
 */
async function connect(root: string): Promise<Client> {
  const tsx = createRequire(import.meta.url).resolve("tsx/cli");
  const server = fileURLToPath(new URL("../src/mcp-server.ts", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsx, server],
    env: { ...process.env, VAULT_DIR: root } as Record<string, string>,
    stderr: "ignore",
  });
  const client = new Client({ name: "scratch-test", version: "0" });
  await client.connect(transport);
  return client;
}

type ToolResult = { isError?: boolean; structuredContent?: any; content: Array<{ text: string }> };

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

test("Claude can add, list, promote, remove and restore scratch notes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vault-mcp-scratch-"));
  const setup = await Vault.init(root);
  await setup.createProject({ key: "ACME", name: "Acme rollout" });

  const client = await connect(root);
  t.after(() => client.close());

  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of [
    "vault_scratch_add",
    "vault_scratch_list",
    "vault_scratch_remove",
    "vault_scratch_restore",
    "vault_scratch_promote",
  ]) {
    assert.ok(names.includes(name), `${name} is registered`);
  }

  const first = await call(client, "vault_scratch_add", { text: "  indented snippet\n  second line" });
  assert.equal(first.isError, undefined);
  const second = await call(client, "vault_scratch_add", { text: "Renew the parking permit" });
  const firstId = first.structuredContent.added.id as string;
  const secondId = second.structuredContent.added.id as string;

  const listed = await call(client, "vault_scratch_list");
  assert.equal(listed.structuredContent.total, 2);
  assert.equal(
    listed.structuredContent.notes.find((n: { id: string }) => n.id === firstId).text,
    "  indented snippet\n  second line",
  );

  // Promote is one call, and the note leaves the pad.
  const promoted = await call(client, "vault_scratch_promote", {
    id: secondId,
    project: "ACME",
    summary: "Renew the parking permit before October ends",
  });
  assert.equal(promoted.isError, undefined, promoted.content[0]?.text);
  assert.equal(promoted.structuredContent.created.key, "ACME-1");
  assert.equal(promoted.structuredContent.created.type, "task");
  assert.equal((await call(client, "vault_scratch_list")).structuredContent.total, 1);

  // A promote the create rules refuse changes nothing.
  const refused = await call(client, "vault_scratch_promote", {
    id: firstId,
    project: "NOPE",
    summary: "x",
  });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]!.text, /Project NOPE does not exist/);
  assert.equal((await call(client, "vault_scratch_list")).structuredContent.total, 1);

  // Remove is recoverable through the trash, like an item.
  const removed = await call(client, "vault_scratch_remove", { id: firstId });
  assert.equal(removed.isError, undefined);
  const trash = await call(client, "vault_list_trash", { scratch: true });
  const entry = trash.structuredContent.entries.find((e: { id: string }) => e.id === firstId);
  assert.equal(entry.preview, "indented snippet");
  const restored = await call(client, "vault_scratch_restore", { file: entry.file });
  assert.equal(restored.structuredContent.restored.text, "  indented snippet\n  second line");

  // The id is checked before it can name a path.
  const bad = await call(client, "vault_scratch_remove", { id: "../items/ACME-1" });
  assert.equal(bad.isError, true);
  assert.equal(
    (await call(client, "vault_list_trash", { projects: true, scratch: true })).isError,
    true,
  );
});
