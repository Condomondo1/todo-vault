/**
 * "Draft with Claude" in the promote panel, against a fake Anthropic API.
 *
 * What this pins down: the button is absent without a key and says what it will
 * do; nothing is sent until it is clicked; the request carries the note's text;
 * the reply fills the form without writing anything and keeps the sticky
 * category; Create is still the only thing that makes an item; an API refusal is
 * shown in the panel; and a reply that arrives after the selection has moved on
 * is dropped instead of landing in another note's form.
 *
 * Nothing here may reach the real API. The harness points the SDK at the fake
 * server through `ANTHROPIC_BASE_URL`, `assertLocalBaseUrl` checks that the app
 * actually received it before a key is stored, and the key is a dummy.
 *
 * One app, one vault, ordered subtests (`{ concurrency: 1 }`).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import type { Page } from "playwright-core";
import { Vault } from "todo-vault";

import type { VaultApi } from "../src/shared/api.js";
import { launchHarness, type Harness } from "./harness.mjs";
import { eventually } from "./drive.mjs";
import { DEFAULT_DRAFT, assertLocalBaseUrl, startFakeClaude, type FakeClaude } from "./fake-claude.mjs";

const DUMMY_KEY = "sk-ant-e2e-dummy-not-a-real-key";
const NOTE_ONE = "Rate limiter drops Retry-After on 429s, see the middleware order";
const NOTE_TWO = "Order the printer toner";
const NOTE_THREE = "Call the plumber about the boiler";

describe("Draft with Claude, driven end to end", { concurrency: 1 }, () => {
  let harness: Harness;
  let page: Page;
  let claude: FakeClaude;

  const panel = () => page.locator("aside.promote");
  const field = (label: string) => panel().locator(`label:has(> span:text-is(${JSON.stringify(label)}))`);
  const summary = () => field("Summary").locator("input");
  const draftButton = () => panel().getByRole("button", { name: /Draft with Claude|Drafting/ });
  const card = (text: string) => page.locator(".scratch-card", { hasText: text });

  before(async () => {
    claude = await startFakeClaude();
    harness = await launchHarness({ env: { ANTHROPIC_BASE_URL: claude.baseUrl } });
    page = harness.page;
    await page.locator("table.table tbody tr").first().waitFor({ state: "visible" });

    const vault = await Vault.open(harness.vaultRoot);
    for (const note of (await vault.listScratch()).notes) await vault.removeScratch(note.id);
    for (const text of [NOTE_THREE, NOTE_TWO, NOTE_ONE]) await vault.addScratch(text);
    await eventually(
      "the notes to reach the sidebar",
      () => page.locator("section.sb-scratch .scratch-row").count(),
      (n) => n === 3,
    );
    await page.locator("section.sb-scratch .sb-more").click();
    await page.locator(".scratch-page").waitFor({ state: "visible" });
  });

  after(async () => {
    await harness.close();
    await claude.close();
  });

  test("without a key the button is replaced by a pointer to where to add one", async () => {
    await card(NOTE_ONE).click();
    await panel().waitFor({ state: "visible" });

    await panel().getByText(/Drafting is off/).waitFor({ state: "visible" });
    assert.equal(await draftButton().count(), 0);
    assert.equal(claude.requests.length, 0);
  });

  test("with a key it offers the button and says it sends the note, and sends nothing yet", async () => {
    // Before any key exists, so a base URL that did not reach the app fails here
    // and not as a billed request.
    await assertLocalBaseUrl(harness.app, claude.baseUrl);
    const status = await page.evaluate(async (key) => {
      const result = await (window as unknown as { vault: VaultApi }).vault.setClaudeKey(key);
      return result.ok ? result.value.hasKey : false;
    }, DUMMY_KEY);
    assert.equal(status, true, "the dummy key was stored");

    // The status is read when the panel mounts, so close it and select again.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await panel().waitFor({ state: "detached" });
    await card(NOTE_ONE).click();
    await panel().waitFor({ state: "visible" });

    await draftButton().waitFor({ state: "visible" });
    await panel().getByText("Sends this note to the Claude API — only when you click.").waitFor({ state: "visible" });

    // Typing, selecting and moving about send nothing.
    await field("Category").locator("input").fill("triage");
    await summary().fill("Edited by hand");
    await page.waitForTimeout(500);
    assert.equal(claude.requests.length, 0, "nothing is sent until the button is clicked");
  });

  test("a click sends the note and fills the form with the reply, keeping the sticky category", async () => {
    claude.reply({
      draft: {
        ...DEFAULT_DRAFT,
        project: "ACME",
        type: "bug",
        summary: "Send Retry-After on 429 responses",
        description: "Suspect middleware order.",
        priority: "high",
        notes: "Guessed the project from the middleware wording.",
      },
    });
    await assertLocalBaseUrl(harness.app, claude.baseUrl);

    await draftButton().click();
    await eventually("the draft to fill Summary", () => summary().inputValue(), (v) => v === "Send Retry-After on 429 responses");

    assert.equal(claude.requests.length, 1);
    const sent = claude.requests[0];
    assert.equal(sent.path.split("?")[0], "/v1/messages");
    assert.equal(sent.body.messages?.[0]?.content, NOTE_ONE, "the note's own text is the prompt");
    assert.match(String(sent.body.system), /ACME/, "the project list is in the context");
    assert.equal(sent.headers["x-api-key"], DUMMY_KEY);

    assert.equal(await field("Type").locator("select").inputValue(), "bug");
    assert.equal(await field("Priority").locator("select").inputValue(), "high");
    assert.equal(
      (await panel().locator("div.description.prose.rich-surface").innerText()).trim(),
      "Suspect middleware order.",
    );
    assert.equal(await field("Category").locator("input").inputValue(), "triage", "a draft with no category leaves the sticky one");
    await panel().getByText(/Claude noted:/).waitFor({ state: "visible" });
    await panel().getByText("Guessed the project from the middleware wording.").waitFor({ state: "visible" });

    const items = (await Vault.open(harness.vaultRoot)).listItems({}).items;
    assert.ok(!items.some((i) => i.summary === "Send Retry-After on 429 responses"), "a draft writes nothing");
  });

  test("Create is what makes it an item, and it is still one request", async () => {
    await summary().focus();
    await page.keyboard.press("Control+Enter");

    const item = await eventually(
      "the drafted item to reach disk",
      async () =>
        (await Vault.open(harness.vaultRoot)).listItems({}).items.find((i) => i.summary === "Send Retry-After on 429 responses"),
      (found) => found !== undefined,
    );
    assert.equal(item?.type, "bug");
    assert.equal(item?.priority, "high");
    assert.equal(item?.category, "triage");
    assert.equal(claude.requests.length, 1, "creating did not call the API again");
  });

  test("a refusal from the API is shown in the panel and fills nothing", async () => {
    claude.reply({ status: 401, error: { type: "authentication_error", message: "invalid x-api-key" } });
    await assertLocalBaseUrl(harness.app, claude.baseUrl);
    // The previous test's Create moves on to the next note; wait for that.
    await eventually("the next note's form", () => summary().inputValue(), (v) => v === NOTE_TWO);
    const before = await summary().inputValue();

    await draftButton().click();
    await panel().locator(".modal-error").waitFor({ state: "visible" });

    assert.match(await panel().locator(".modal-error").innerText(), /key was rejected/i);
    assert.equal(await summary().inputValue(), before);
    assert.equal(await draftButton().isEnabled(), true, "and the button is back");
  });

  test("a reply that arrives after the selection moved on is dropped", async () => {
    claude.reply({
      delayMs: 700,
      draft: { ...DEFAULT_DRAFT, summary: "Drafted for the wrong note" },
    });
    await assertLocalBaseUrl(harness.app, claude.baseUrl);
    const requestsBefore = claude.requests.length;

    await draftButton().click();
    await eventually("the request to be sent", async () => claude.requests.length, (n) => n === requestsBefore + 1);

    // Move to the other note while the reply is still on its way.
    await page.keyboard.press("j");
    await eventually("the form to show the other note", () => summary().inputValue(), (v) => v === NOTE_THREE);
    const shown = await summary().inputValue();

    await page.waitForTimeout(1200);
    assert.equal(await summary().inputValue(), shown, "the late draft did not overwrite this note's form");
    assert.equal(await panel().getByText(/Claude noted:/).count(), 0);
  });
});
