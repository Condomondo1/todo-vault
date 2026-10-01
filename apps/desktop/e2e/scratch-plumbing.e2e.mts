/**
 * The scratch pad's plumbing, end to end, before any UI exists for it: that a
 * vault without a `scratch/` folder gets one, that a note written from outside
 * the app (what an MCP add is) reaches the renderer through the watcher, that a
 * note which does not parse is reported rather than swallowed, and that the
 * five IPC calls round-trip against the real vault on disk.
 *
 * With no sidebar section to look at yet, the renderer side is observed where
 * it is fed: a subscriber on `window.vault.onChanged` collects every snapshot
 * main pushes, which is exactly what `useVault` adopts.
 *
 * The seeded vault ships with notes, so `before` launches once, closes, deletes
 * `scratch/` and relaunches against the same stem — the shape of a vault made
 * before the pad existed.
 *
 * One app, one vault, ordered subtests (`{ concurrency: 1 }`).
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { Vault } from "todo-vault";
import type { VaultApi, VaultSnapshot } from "../src/shared/api.js";
import { launchHarness, type Harness } from "./harness.mjs";
import { eventually } from "./drive.mjs";

type Bridge = { vault: VaultApi; __snapshots?: VaultSnapshot[] };

describe("scratch notes reach the renderer", { concurrency: 1 }, () => {
  let harness: Harness;

  /** The newest snapshot main has pushed since the subscriber was installed. */
  const latest = (): Promise<VaultSnapshot | null> =>
    harness.page.evaluate(() => {
      const w = window as unknown as Bridge;
      return w.__snapshots?.at(-1) ?? null;
    });

  before(async () => {
    const first = await launchHarness();
    const stem = first.stem;
    await first.close({ keepStem: true });
    await fs.rm(path.join(first.vaultRoot, "scratch"), { recursive: true, force: true });

    harness = await launchHarness({ stem });
    await harness.page.locator("table.table tbody tr").first().waitFor({ state: "visible" });
    await harness.page.evaluate(() => {
      const w = window as unknown as Bridge;
      w.__snapshots = [];
      w.vault.onChanged((snapshot) => w.__snapshots!.push(snapshot));
    });
  });

  after(async () => {
    await harness.close();
  });

  test("opening a vault with no scratch folder creates one", async () => {
    const stat = await fs.stat(path.join(harness.vaultRoot, "scratch"));
    assert.ok(stat.isDirectory());
  });

  test("the first snapshot carries an empty pad", async () => {
    const snapshot = await harness.page.evaluate(async () => {
      const result = await (window as unknown as Bridge).vault.getSnapshot();
      return result.ok ? result.value : null;
    });

    assert.deepEqual(snapshot?.scratch, []);
  });

  test("a note written from outside the app is pushed to the renderer", async () => {
    // What an MCP add does: a separate process, through the core, not the app.
    const outside = await Vault.open(harness.vaultRoot);
    const note = await outside.addScratch("From outside the app");

    const snapshot = await eventually(
      "the watcher to push the new note",
      latest,
      (s) => s !== null && s.scratch.some((n) => n.id === note.id),
    );
    assert.equal(snapshot?.scratch.find((n) => n.id === note.id)?.text, "From outside the app");
  });

  test("a note that does not parse is reported, and does not hide the others", async () => {
    const broken = path.join(harness.vaultRoot, "scratch", "11111111-1111-4111-8111-111111111111.md");
    await fs.writeFile(broken, "---\nid: not-a-uuid\n---\n\nbroken\n");

    const snapshot = await eventually(
      "the watcher to report the broken note",
      latest,
      (s) => s !== null && s.errors.some((e) => e.includes("scratch/11111111-1111-4111-8111-111111111111.md")),
    );
    assert.ok(snapshot!.scratch.some((n) => n.text === "From outside the app"));
    assert.ok(!snapshot!.scratch.some((n) => n.text.includes("broken")));

    await fs.rm(broken);
    await eventually(
      "the report to clear once the file is gone",
      latest,
      (s) => s !== null && !s.errors.some((e) => e.includes("scratch/")),
    );
  });

  test("add, remove, list the trash and restore round-trip through IPC", async () => {
    const result = await harness.page.evaluate(async () => {
      const { vault } = window as unknown as Bridge;
      // No helper function in here: tsx wraps named functions in a __name call
      // that does not exist in the page, so each result is checked inline.
      const added = await vault.addScratch(["  ", "through IPC  ", ""].join(String.fromCharCode(10)));
      if (!added.ok) throw new Error(added.message);
      const afterAdd = added.value.snapshot.scratch.map((n) => n.id);

      const removed = await vault.removeScratch(added.value.note.id);
      if (!removed.ok) throw new Error(removed.message);
      const afterRemove = removed.value.snapshot.scratch.map((n) => n.id);
      const trash = await vault.listTrashedScratch();
      if (!trash.ok) throw new Error(trash.message);

      const restored = await vault.restoreScratch(removed.value.removed.file);
      if (!restored.ok) throw new Error(restored.message);
      const listed = await vault.listScratch();
      if (!listed.ok) throw new Error(listed.message);

      const blank = await vault.addScratch("   ");

      return {
        id: added.value.note.id,
        text: added.value.note.text,
        afterAdd,
        afterRemove,
        removedFile: removed.value.removed.file,
        trashIds: trash.value.map((t) => t.id),
        restoredId: restored.value.note.id,
        afterRestore: restored.value.snapshot.scratch.map((n) => n.id),
        listed: listed.value.notes.map((n) => n.id),
        blankRefused: blank.ok ? null : blank.message,
      };
    });

    assert.equal(result.text, "through IPC", "leading blank lines and trailing whitespace are dropped");
    assert.ok(result.afterAdd.includes(result.id));
    assert.ok(!result.afterRemove.includes(result.id));
    assert.ok(result.removedFile.startsWith(result.id));
    assert.ok(result.trashIds.includes(result.id));
    assert.equal(result.restoredId, result.id);
    assert.ok(result.afterRestore.includes(result.id));
    assert.ok(result.listed.includes(result.id));
    assert.match(result.blankRefused ?? "", /needs some text/);

    // The disk says the same thing the snapshots did.
    const onDisk = await fs.readdir(path.join(harness.vaultRoot, "scratch"));
    assert.ok(onDisk.includes(`${result.id}.md`));
  });

  test("update replaces a note's text in place, and is refused once the note is gone", async () => {
    const result = await harness.page.evaluate(async () => {
      const { vault } = window as unknown as Bridge;
      const added = await vault.addScratch("before the edit");
      if (!added.ok) throw new Error(added.message);
      const updated = await vault.updateScratch(added.value.note.id, "after the edit");
      if (!updated.ok) throw new Error(updated.message);
      const removed = await vault.removeScratch(added.value.note.id);
      if (!removed.ok) throw new Error(removed.message);
      const late = await vault.updateScratch(added.value.note.id, "too late");

      return {
        added: added.value.note,
        note: updated.value.note,
        inSnapshot: updated.value.snapshot.scratch.find((n) => n.id === added.value.note.id)?.text ?? null,
        lateRefused: late.ok ? null : late.message,
      };
    });

    assert.equal(result.note.id, result.added.id);
    assert.equal(result.note.created, result.added.created, "keeps its place in the list");
    assert.equal(result.note.text, "after the edit");
    assert.equal(result.inSnapshot, "after the edit", "and the snapshot answering it already has it");
    assert.match(result.lateRefused ?? "", /^No scratch note/);
  });
});
