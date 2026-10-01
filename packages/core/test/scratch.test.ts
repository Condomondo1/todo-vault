import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { SCRATCH_MAX_CHARS, Vault, VaultError } from "../src/vault.js";
import { keyFromPath } from "../src/history.js";

const execFileAsync = promisify(execFile);

async function tmpVault(): Promise<Vault> {
  return Vault.init(await fs.mkdtemp(path.join(os.tmpdir(), "vault-scratch-")));
}

async function gitVault(): Promise<Vault> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-scratch-git-"));
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  return Vault.init(dir, { git: true });
}

async function subjects(dir: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["log", "--format=%s"], { cwd: dir });
  return stdout.trim().split("\n");
}

test("a note is one file, scratch/<id>.md, with id and created as frontmatter", async () => {
  const vault = await tmpVault();
  const note = await vault.addScratch("Ask Dana about the questionnaire");

  const raw = await fs.readFile(path.join(vault.root, "scratch", `${note.id}.md`), "utf8");
  assert.equal(
    raw,
    `---\nid: ${note.id}\ncreated: ${note.created}\n---\n\nAsk Dana about the questionnaire\n`,
  );
  assert.deepEqual((await vault.listScratch()).notes, [note]);
});

test("the text survives verbatim, including a pasted snippet's first-line indentation", async () => {
  const vault = await tmpVault();
  const snippet = "  retry: 3\n  backoff: exponential\n\n\n  max_wait: 30s";
  const note = await vault.addScratch(`\r\n\n${snippet.replace(/\n/g, "\r\n")}  \n\n`);

  assert.equal(note.text, snippet);
  assert.equal((await vault.listScratch()).notes[0]?.text, snippet);
});

test("a fenced block and a body line of --- do not confuse the reader", async () => {
  const vault = await tmpVault();
  const text = "SQL:\n```sql\nSELECT 1;\n```\n---\nafter a rule";
  await vault.addScratch(text);
  assert.equal((await vault.listScratch()).notes[0]?.text, text);
});

test("a blank note and an oversized one are refused, and nothing is written", async () => {
  const vault = await tmpVault();
  await assert.rejects(vault.addScratch(" \n\t\n"), VaultError);
  await assert.rejects(vault.addScratch("x".repeat(SCRATCH_MAX_CHARS + 1)), /limit is 100,000/);
  assert.deepEqual(await vault.listScratch(), { notes: [], errors: [] });
});

test("notes list newest first", async () => {
  const vault = await tmpVault();
  const first = await vault.addScratch("first");
  await new Promise((r) => setTimeout(r, 5));
  const second = await vault.addScratch("second");
  assert.deepEqual(
    (await vault.listScratch()).notes.map((n) => n.id),
    [second.id, first.id],
  );
});

test("a vault from before the pad lists no notes, and ensureScratchDir creates the folder", async () => {
  const vault = await tmpVault();
  const dir = path.join(vault.root, "scratch");
  await assert.rejects(fs.stat(dir));
  assert.deepEqual(await vault.listScratch(), { notes: [], errors: [] });

  await vault.ensureScratchDir();
  assert.ok((await fs.stat(dir)).isDirectory());
  await vault.ensureScratchDir(); // idempotent
});

test("a broken note is skipped and reported, and the rest still list", async () => {
  const vault = await tmpVault();
  const good = await vault.addScratch("still here");
  const dir = path.join(vault.root, "scratch");
  const otherId = "00000000-0000-4000-8000-000000000001";
  await fs.writeFile(path.join(dir, "11111111-1111-4111-8111-111111111111.md"), "---\nid: [\n---\n\nbad yaml\n");
  await fs.writeFile(
    path.join(dir, "22222222-2222-4222-8222-222222222222.md"),
    `---\nid: ${otherId}\ncreated: 2026-10-01T00:00:00.000Z\n---\n\nid does not match the filename\n`,
  );
  await fs.writeFile(path.join(dir, "README.txt"), "not a note");

  const { notes, errors } = await vault.listScratch();
  assert.deepEqual(notes, [good]);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => e.startsWith("scratch/11111111-") && /YAML/.test(e)));
  assert.ok(errors.some((e) => e.startsWith("scratch/22222222-") && /does not match its filename/.test(e)));
});

test("a field from a newer version is not a reason to drop the note", async () => {
  const vault = await tmpVault();
  await vault.ensureScratchDir();
  const id = "33333333-3333-4333-8333-333333333333";
  await fs.writeFile(
    path.join(vault.root, "scratch", `${id}.md`),
    `---\nid: ${id}\ncreated: 2026-10-01T00:00:00.000Z\nmono: true\n---\n\n  indented\n`,
  );
  const { notes, errors } = await vault.listScratch();
  assert.deepEqual(errors, []);
  assert.deepEqual(notes, [{ id, created: "2026-10-01T00:00:00.000Z", text: "  indented" }]);
});

test("remove moves the note to .trash/scratch, and restore puts it back unchanged", async () => {
  const vault = await tmpVault();
  const note = await vault.addScratch("```\ncode first\n```\nRenew the parking permit");
  const before = await fs.readFile(path.join(vault.root, "scratch", `${note.id}.md`), "utf8");

  const removed = await vault.removeScratch(note.id);
  assert.equal(removed.id, note.id);
  assert.equal(removed.trashedTo, `.trash/scratch/${removed.file}`);
  assert.deepEqual((await vault.listScratch()).notes, []);

  const trash = await vault.listTrashedScratch();
  assert.equal(trash.length, 1);
  assert.equal(trash[0]?.file, removed.file);
  assert.equal(trash[0]?.id, note.id);
  // The preview skips the fence line, as the sidebar does.
  assert.equal(trash[0]?.preview, "code first");

  assert.deepEqual(await vault.restoreScratch(removed.file), note);
  assert.equal(await fs.readFile(path.join(vault.root, "scratch", `${note.id}.md`), "utf8"), before);
  assert.deepEqual(await vault.listTrashedScratch(), []);
  await assert.rejects(vault.restoreScratch(removed.file), /Nothing called/);
});

test("restore refuses to overwrite a note that is back on the pad", async () => {
  const vault = await tmpVault();
  const note = await vault.addScratch("twice");
  const { file } = await vault.removeScratch(note.id);
  const trashed = path.join(vault.root, ".trash", "scratch", file);
  await fs.copyFile(trashed, path.join(vault.root, "scratch", `${note.id}.md`));
  await assert.rejects(vault.restoreScratch(file), /already on the pad/);
  assert.ok(await fs.stat(trashed)); // left where it was
});

test("ids and trash filenames from outside never name a path", async () => {
  const vault = await tmpVault();
  await assert.rejects(vault.removeScratch("../items/ACME-1"), /Not a scratch note id/);
  await assert.rejects(vault.removeScratch("00000000-0000-4000-8000-000000000000"), /No scratch note/);
  await assert.rejects(vault.restoreScratch("../../items/ACME-1.md"), /Expected a filename/);
  await assert.rejects(vault.restoreScratch("ACME-1-2026-10-01T00-00-00-000Z.md"), /Expected a filename/);
});

test("two processes adding and removing at once lose nothing", async () => {
  // Two Vault instances over one folder stand in for the app and the MCP
  // server. A shared file would be read-modify-write under this interleaving;
  // with one file per note every add and remove has to land.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vault-scratch-race-"));
  await Vault.init(root);
  const app = await Vault.open(root);
  const claude = await Vault.open(root);

  const seeded = await Promise.all(Array.from({ length: 10 }, (_, i) => app.addScratch(`seed ${i}`)));
  const doomed = seeded.filter((_, i) => i % 2 === 0);

  const [fromApp, fromClaude] = await Promise.all([
    Promise.all(Array.from({ length: 15 }, (_, i) => app.addScratch(`app ${i}`))),
    Promise.all(Array.from({ length: 15 }, (_, i) => claude.addScratch(`claude ${i}`))),
    Promise.all(doomed.map((n, i) => (i % 2 ? app : claude).removeScratch(n.id))),
  ]);

  const expected = new Set(
    [...seeded.filter((n) => !doomed.includes(n)), ...fromApp, ...fromClaude].map((n) => n.id),
  );
  const listed = await app.listScratch();
  assert.deepEqual(listed.errors, []);
  assert.deepEqual(new Set(listed.notes.map((n) => n.id)), expected);
  assert.equal((await claude.listTrashedScratch()).length, doomed.length);
});

test("add, remove and restore are one commit each, and History shows them", async () => {
  const vault = await gitVault();
  const note = await vault.addScratch("Book the dentist\nsecond line");
  const { file } = await vault.removeScratch(note.id);
  await vault.restoreScratch(file);

  assert.deepEqual((await subjects(vault.root)).slice(0, 3), [
    "Restore scratch note from trash",
    "Trash scratch note",
    "Add scratch note",
  ]);

  const { entries } = await vault.history();
  const [restored, trashed, added] = entries;
  for (const entry of [restored, trashed, added]) {
    assert.equal(entry?.files.length, 1);
    assert.equal(entry?.files[0]?.subject, "scratch");
    assert.equal(entry?.files[0]?.key, note.id);
  }
  assert.equal(added?.files[0]?.kind, "added");
  assert.equal(added?.files[0]?.title, "Book the dentist");
  assert.equal(trashed?.files[0]?.kind, "trashed");
  assert.equal(restored?.files[0]?.kind, "restored");
});

test("keyFromPath reads both scratch locations", () => {
  const id = "44444444-4444-4444-8444-444444444444";
  assert.deepEqual(keyFromPath(`scratch/${id}.md`), { subject: "scratch", key: id });
  assert.deepEqual(keyFromPath(`.trash/scratch/${id}-2026-10-01T14-02-11-123Z.md`), {
    subject: "scratch",
    key: id,
  });
  assert.deepEqual(keyFromPath("scratch/notes.txt"), { subject: "other" });
});

// ---------------------------------------------------------------- promote

async function promotable(): Promise<Vault> {
  const vault = await gitVault();
  await vault.createProject({ key: "ACME", name: "Acme rollout" });
  return vault;
}

async function commitCount(dir: string): Promise<number> {
  const { stdout } = await execFileAsync("git", ["rev-list", "--count", "HEAD"], { cwd: dir });
  return Number.parseInt(stdout.trim(), 10);
}

test("promote writes the item and trashes the note in one commit", async () => {
  const vault = await promotable();
  const note = await vault.addScratch("Renew the parking permit\nexpires end of Oct");
  const before = await commitCount(vault.root);

  const item = await vault.promoteScratch(note.id, {
    project: "ACME",
    type: "task",
    summary: "Renew the parking permit",
    description: "expires end of Oct",
  });

  assert.equal(item.key, "ACME-1");
  assert.equal(vault.getItem("ACME-1").description, "expires end of Oct");
  assert.deepEqual((await vault.listScratch()).notes, []);
  assert.equal((await vault.listTrashedScratch())[0]?.id, note.id);

  assert.equal(await commitCount(vault.root), before + 1);
  assert.equal((await subjects(vault.root))[0], "Promote scratch note to ACME-1");
  const [entry] = (await vault.history()).entries;
  assert.deepEqual(
    entry?.files.map((f) => [f.subject, f.kind]).sort(),
    [
      ["item", "added"],
      ["scratch", "trashed"],
    ],
  );
});

test("promote with keep leaves the note on the pad, still one commit", async () => {
  const vault = await promotable();
  const note = await vault.addScratch("one thought, two items");
  const before = await commitCount(vault.root);

  await vault.promoteScratch(note.id, { project: "ACME", type: "task", summary: "First" }, { keep: true });

  assert.deepEqual((await vault.listScratch()).notes, [note]);
  assert.equal(await commitCount(vault.root), before + 1);
  assert.equal((await subjects(vault.root))[0], "Promote scratch note to ACME-1");
});

test("a promote that fails validation writes nothing and keeps the note", async () => {
  const vault = await promotable();
  const note = await vault.addScratch("keep me");
  const before = await commitCount(vault.root);

  await assert.rejects(
    vault.promoteScratch(note.id, { project: "NOPE", type: "task", summary: "x" }),
    /Project NOPE does not exist/,
  );
  await assert.rejects(
    vault.promoteScratch(note.id, { project: "ACME", type: "task", summary: "x".repeat(256) }),
  );

  assert.deepEqual((await vault.listScratch()).notes, [note]);
  assert.equal(vault.listItems().total, 0);
  assert.equal(await commitCount(vault.root), before);
});

test("promoting a note that is gone creates no item", async () => {
  const vault = await promotable();
  const note = await vault.addScratch("removed elsewhere");
  await vault.removeScratch(note.id);

  await assert.rejects(
    vault.promoteScratch(note.id, { project: "ACME", type: "task", summary: "x" }),
    /No scratch note/,
  );
  await assert.rejects(
    vault.promoteScratch("../items/ACME-1", { project: "ACME", type: "task", summary: "x" }),
    /Not a scratch note id/,
  );
  assert.equal(vault.listItems().total, 0);
});

test("createItem is still one commit of its own after the split", async () => {
  const vault = await promotable();
  const before = await commitCount(vault.root);
  await vault.createItem({ project: "ACME", type: "task", summary: "Plain create" });
  assert.equal(await commitCount(vault.root), before + 1);
  assert.equal((await subjects(vault.root))[0], "Add ACME-1: Plain create");
});

test("if the note cannot be trashed, the item is kept and committed and the error says so", async () => {
  // The order is the guarantee: item first, note second. A failure in between
  // leaves both, a duplicate rather than a lost note. A file where the
  // .trash/scratch folder should be makes the second step fail on cue.
  const vault = await promotable();
  const note = await vault.addScratch("survives a failed trash");
  await fs.mkdir(path.join(vault.root, ".trash"), { recursive: true });
  await fs.writeFile(path.join(vault.root, ".trash", "scratch"), "in the way");
  const before = await commitCount(vault.root);

  await assert.rejects(
    vault.promoteScratch(note.id, { project: "ACME", type: "task", summary: "Kept" }),
    /Created ACME-1, but the note stayed on the scratch pad/,
  );
  assert.equal(vault.getItem("ACME-1").summary, "Kept");
  assert.deepEqual((await vault.listScratch()).notes, [note]);
  assert.equal(await commitCount(vault.root), before + 1);
});
