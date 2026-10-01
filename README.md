# todo-vault

A local, Jira-shaped task tracker that lives in plain markdown files.

Every task is a markdown file with YAML frontmatter. That one decision lets a
desktop app, a command line, and any Claude (inside the app or outside it) read
and write the same data with no server, no database and no sync protocol. Your
tasks stay files you own, greppable and diffable, and git gives you history and
undo.

It is shaped like Jira on purpose: epics, stories, tasks, bugs, subtasks, a real
status workflow, priorities, labels and links. That way work can be pushed *up*
to Jira when it needs to be shared. The vault is always upstream, never a
mirror.

> **Status:** the vault core, CLI, MCP server and desktop app are built and in
> daily use. The desktop app creates and updates Jira issues from a review pane
> and has been used against a production Jira Cloud site. The CLI and MCP server
> plan a push but never send one. See [`PLAN.md`](PLAN.md) for what was built and
> why, and [`IDEAS.md`](IDEAS.md) for what is being considered next.

---

## What you get

**A desktop app.** It has five views over one vault, on keys `1`–`5`:
- a backlog table with nested subtasks
- a drag-and-drop board
- an agenda over six time scopes
- a month calendar, where you reschedule by dragging a chip to another day
- a History view that reads the git log back as field changes
  (`dueDate 2026-08-06 → 2026-08-19`)

Behind all five is a detail panel where every edit commits straight to the
file. There is no save button, and a click beside the panel closes it, unless a
comment is still unsent. Illegal status moves are prevented, not attempted.
Descriptions are edited as rich text and stored as plain markdown. Recurring
work is ticked off for the current period rather than closed. Press `?` for
every keyboard shortcut, and `Ctrl+K` to search everything.

**A scratch pad.** The sidebar has a Scratch section on every view: the newest
notes, a count, and a **+ new** (or `Shift+N`) that jots a note without leaving
what you are doing. **More…** (or `6`) opens the full page. Notes are global,
not filed under any project, and each is one file in `scratch/`. Removing one
sends it to the trash with an Undo. Select a note and a panel opens beside
it with the item form already filled from the note's text (a local guess, not a
call to Claude): `Ctrl+Enter` creates the item, the note leaves the pad, and the
next note is selected. Project, parent and category carry over from one item to
the next.

**A command line.** Everything the app does, plus diagnostics and exports.

**An MCP server.** Point Claude Desktop or Claude Code at the vault and ask in
plain language: *"what's due this week"*, *"add a task to chase the vendor SOW,
due Friday, under the migration epic"*. It has twenty-seven tools, and every
write is checked against the schema and the hierarchy rules.

**Push to Jira from the app.** Connect one Jira Cloud project once. Choose items
and review exactly what will be sent. Then create the issues, or update the
ones that changed since their last push, field by field. See
[Pushing to Jira](#pushing-to-jira).

**Optional AI drafting.** Add an Anthropic API key, and the create dialog turns
a sentence into a filled-in form for you to review before anything is written.

**History and undo through git.** The app commits every write. If the vault is
not a git repository yet, a banner offers **Turn on history**. Deletes go to
`.trash/` regardless, so recovery never depends on git.

---

## Requirements

| | |
|---|---|
| **Node.js 22+** | Developed against 24; CI runs both. |
| **Git** *(recommended)* | Without it the vault keeps no history. |
| **~350 MB disk** | Electron's runtime, downloaded on first build and cached. |
| **An Anthropic API key** *(optional)* | Only for in-app AI drafting. |
| **A Jira Cloud API token** *(optional)* | Only for pushing to Jira. |

The app is developed and used on Windows. The toolchain also runs on macOS and
Linux. New machine? See [`GETTING-STARTED.md`](GETTING-STARTED.md).

---

## Fastest path (Windows, nothing installed yet)

```powershell
irm https://raw.githubusercontent.com/rellik92j/todo-vault/main/scripts/bootstrap.ps1 | iex
```

It does four things:
- installs Node and Git with `winget` if either is missing
- clones the repo
- runs `npm install`
- opens the menu

This runs a script from this repo over the network, so read
[`scripts/bootstrap.ps1`](scripts/bootstrap.ps1) first if that concerns you.

It may ask one question. Windows ships PowerShell set to refuse scripts, and
`npm` is one, so every `npm` command fails with a security error. The script
offers to set **your account** (not the machine) to `RemoteSigned`. That needs
no administrator rights. Decline and it still finishes, but your own `npm`
commands stay blocked.

---

## Quick start, with an example vault

```bash
git clone https://github.com/rellik92j/todo-vault.git
cd todo-vault
npm install
npm run build          # first run downloads Electron (~350 MB, cached after)
npm run seed -- ./vault
npm run dev
```

The example vault has three projects and fifteen items:
- an epic with stories, tasks, a subtask and a bug
- daily, weekly and monthly recurring items
- every link type
- a hidden project
- one item already pushed to Jira

Rebuild it any time with `npm run seed -- ./vault --force`. That clears the
contents but leaves `.git` alone.

---

## Running it

### The menu

```bash
npm run menu
```

A numbered launcher for everything. Pick an option with a **single keypress**.
It returns to the menu when the command finishes.

```
  todo-vault — workspace commands
  ──────────────────────────────────────────────────────────

  Run
   [1] Dev app                          builds core, then Vite dev server + HMR
   [2] Prod preview                     builds core, then production bundles
   [3] Prod preview (reuse last build)  launches without rebuilding
   [4] MCP server                       stdio server over the vault

  Check
   [5] Test                             both workspaces
   [6] Typecheck                        both workspaces, plus these scripts
   [7] Build                            both workspaces

  Vault
   [8] Vault CLI…                       asks for arguments, e.g. agenda week
   [9] Doctor                           validate every file and report problems
   [S] Seed example vault               the worked example; overwriting asks first

  Setup
   [U] Update                           git pull --ff-only, reinstall, rebuild core
   [I] Install dependencies             npm install only — no pull, no build
   [D] Desktop shortcut                 double-click to start the app, no terminal
   [C] Connect Claude…                  prints the MCP config, paths filled in

   [0] Exit
```

Three options ask for input:
- **[8]** passes your arguments to the CLI, with quotes honoured.
- **[S]** asks you to type `FORCE` before it overwrites an existing vault.
- **[C]** prints the MCP config for this machine. It never edits your Claude
  config file for you.

`Ctrl+C` inside a running command stops that command and returns to the menu.

### Or run the scripts directly

| Command | What it does |
|---|---|
| `npm run dev` | Builds the core and launches the app with hot reload. |
| `npm run preview` | Builds the core, then the production preview. Closest to what ships. |
| `npm run preview:skip-build` | The same preview without rebuilding. |
| `npm run build` | Builds both workspaces. |
| `npm test` | Runs the unit tests in both workspaces and the scripts. |
| `npm run e2e` | Builds, then drives the real app against a throwaway vault. Slow. |
| `npm run typecheck` | Both workspaces, plus `scripts/`. |
| `npm run vault -- <args>` | The vault CLI. |
| `npm run mcp` | The MCP server, over stdio. |
| `npm run seed -- <dir>` | Builds the example vault. |
| `npm run update` | Pulls, reinstalls and rebuilds the core. Refuses rather than merging if you have diverged. |
| `npm run shortcut` | Writes a desktop shortcut that starts the built app with no terminal. |
| `npm run check-updates` | Says whether the build is stale or a newer version is upstream. |

### Starting it without a terminal (Windows)

```bash
npm run shortcut
```

This writes `todo-vault.lnk` to your desktop, the same as the menu's **[D]**. A
double-click starts the app with no console window. Opening it a second time
brings the running window forward instead of opening another.

**The shortcut launches what is built, and does not build.** If nothing is built,
it says so in a dialog.

**It checks whether you are behind.** Just after the window appears, it checks
two things in the background:
- whether the build is older than the source
- whether the remote has newer commits

If either is true, a dialog offers to update. **Yes** opens a terminal to do it,
and **No** does nothing. With no git, no network or no remote, it stays silent.

Run it again if you move the repo. The shortcut still needs the clone and the
build on that machine; [`PACKAGING.md`](PACKAGING.md) covers moving a copy.

---

## The CLI

Run it from the repo root:

```bash
npm run vault -- agenda week --vault ./vault
```

The everyday commands:

```
new --project KEY --summary "..."   Create an item
list [--project --status --open]    List items
show KEY                            Full item, children, backlinks, comments
set KEY --status done --due DATE    Update fields
done KEY                            Shorthand for --status done
tick KEY [--on DATE] [--undo]       Recurring work: done for this period
agenda [SCOPE]                      What needs attention
history [KEY|PROJ]                  What changed, newest first, from the git log
comment KEY "text"                  Append to the running log
link KEY --url|--item|--file X      Link arbitrary content
delete KEY [--cascade]              Move to .trash, recoverable
doctor                              Validate every file, find dangling links
```

There is more: `init`, `disregard`, `attach`, `move`, `trash` and `restore`,
`git-status`, a `project` group (create, rename, reorder, hide, move items,
delete), and the `jira` commands below. **Run `npm run vault` with no arguments
for the complete list**, including every field flag.

| Global flag | |
|---|---|
| `--vault <dir>` | Vault location. Defaults to `$VAULT_DIR`, then `./vault`. |
| `--git` | Auto-commit every write. The desktop app always does this. |
| `--json` | Machine-readable output. |

**Agenda scopes:** `today` (the default), `week`, `nextWeek`, `twoWeeks`,
`month` and `next30Days`. Weeks run Monday to Sunday. The longer scopes split
their output into bands, nearest first.

**Flags worth knowing:**
- `list --sort rank` gives the manual order. The default sorts by urgency.
- `link` takes `--url`, `--item`, `--file`, `--folder`, `--outlook` and
  `--note`.
- `attach --no-copy` links a file in place instead of copying it. Use it for
  anything in OneDrive or SharePoint.

---

## Wiring up Claude

The MCP server exposes the vault over stdio. Run `npm run menu` → **[C]** to
print this config with your machine's paths filled in. Add it to Claude
Desktop's `claude_desktop_config.json`, or to your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "todo-vault": {
      "command": "node",
      "args": ["/absolute/path/to/todo-vault/packages/core/dist/mcp-server.js"],
      "env": {
        "VAULT_DIR": "/absolute/path/to/your/vault",
        "VAULT_GIT": "1"
      }
    }
  }
}
```

**The path is the built server, so run `npm run build` first.** A wrong path
fails silently: Claude reports no error, and the tools never appear.

**Cowork needs nothing extra.** It reads the same config through Claude Desktop.
Quit Desktop fully and reopen it after editing the file. Closing it to the tray
is not quitting.

The twenty-seven tools cover:
- **Reading:** filtered lists, a full item with children and backlinks, the
  agenda, and the project list.
- **Writing:** create, update, move through the workflow, tick recurring work,
  reorder, comment, link and attach.
- **Projects:** create, rename (which re-keys every item), reorder, hide, and
  move an item with its subtree.
- **Recovery:** delete to `.trash/`, list what can be restored, and restore it.
- **Jira:** plan a push, and record one that was made.

Destructive tools refuse rather than guess. For example, deleting an item with
children returns the list of what is in the way.

Some operations exist on only one surface:
- `doctor`, `git-status`, `jira csv` and `jira record` are CLI-only.
- `history` is in the CLI and the app.
- Bulk edit and sending to Jira are app-only.

---

## Pushing to Jira

The vault is upstream of Jira. Nothing is ever pulled back into an item. **Only
the desktop app sends anything to Jira**, and only after you have reviewed it.

### From the app

**1. Connect.** Press **Jira** at the foot of the sidebar.
- Enter your site, your email and an API token from
  [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens).
  Classic and scoped tokens both work.
- The app checks the token with Jira before it stores anything.
- The token is encrypted with the operating system's credential store. It is
  never written to the vault and never shown again.

**2. Map.** On the **Mapping** tab:
- Load your project and choose a Jira issue type for each vault type.
- Pick the fields for start date, estimate and category.
- The app offers only what that project's screens actually have.
- Save writes `jira-map.yaml` into the vault and commits it. The file's
  explanatory comments are kept.

**3. Fill the gaps.** The Mapping tab names any field Jira requires that nothing
fills, such as *"Story requires Team"*. **Fill it in** adds it as an
**extra field**. Each extra field is set one of two ways:
- **Send on every issue**, with a fixed value.
- **Ask on each push**, prefilled, so you can change it for one batch.

Values are typed as you would say them, and the app builds the JSON Jira needs:

| Field kind | You enter |
|---|---|
| Paragraph text | Plain text, with `**bold**`, `- lists` and `[links](…)` |
| Select, multi-select, version, component | A choice from Jira's own list |
| Two-level select | Two dropdowns |
| Person | Someone you've linked, or a search of the site |
| Labels and lists | A comma-separated list |
| Date, number, sprint id, team id | That value |

A value Jira would refuse shows its problem under the field. Fields Jira sets
itself, such as Rank, are never offered. An older map with a `defaults` block
offers **Convert** to turn those entries into extra fields.

**4. Link people.** In the **People** section, **Find everyone in Jira**
searches for each assignee in your vault. A single match links automatically,
and anything else waits for you to choose. Anyone left unlinked is created
unassigned, and the push says so.

**5. Push.** Check items in the backlog and choose **Push to Jira…** from the
bulk bar. You can also use `Ctrl+K`, or an unpushed item's Jira row. The pane
shows:
- **Each issue to create**, field by field, with **Show JSON** for the exact
  request.
- **Changed since pushed**, for items edited after their last push. Each row
  shows Jira's current value next to the vault's.
  - Untick a field to keep Jira's value.
  - Untick every field to leave the item for a later push.
  - If Jira already matches, **Mark as in sync** clears the changed state with
    nothing sent.
- **Anything that would fail**, with the reason, before anything is sent.

The button says what it will do, e.g. **Create 2 and update 1 in ENG**.
- Parents are created before children.
- Each issue is recorded in the vault the moment Jira confirms it.
- A connection that drops mid-push is remembered. The next push asks whether
  that issue reached Jira before it can be sent again, so nothing is created
  twice.

### Without the app: CSV import

`jira csv` writes a file for Jira Cloud's external import. Use it when there is
no API token or the site is hard to reach.

```bash
npm run vault -- jira csv --vault ./vault --out issues.csv
# import it: Settings > System > External System Import > CSV
npm run vault -- jira record --vault ./vault --from jira-export.csv
```

It exports open items by default. Add `--all` to include closed ones, or
`--reporter` to add a Reporter column. On the import screen:
- **Map `Issue Id` and `Parent id`.** Skip them and every item arrives
  unparented, with no error.
- **`Labels` and `Components` repeat**, one column per value. The command prints
  the column list.
- **The import is a site-admin screen.** Without the permission it is missing
  from the menu.

Afterwards, run **`jira record`** on a CSV exported back out of Jira, with the
local keys and the new issue keys. That stops the next export creating
everything again. `--dry` reports without writing.

### Planning from the CLI or Claude

`jira plan` (and the MCP tool `vault_plan_jira_push`) writes the create payloads
the app would send, as JSON, without sending them. `jira discover` reads one
project's fields and prints a `jira-map.yaml` fragment. It needs `JIRA_EMAIL`
and `JIRA_TOKEN` in the environment. The app's Mapping tab does the same job
with less typing.

---

## Project layout

An npm workspace with two packages:

| | |
|---|---|
| `packages/core` | The vault: schema, read/write, CLI, MCP server, Jira planner and client |
| `apps/desktop` | The Electron app over it |

The core has no idea the app exists, and the app holds no state the vault does
not. `schema.ts` is the source of truth: every write is validated against it.
Read [`SCHEMA.md`](SCHEMA.md) before changing it. The app watches the vault, so
an edit from the CLI, an external Claude or a text editor shows up within about
a second.

### Tests

- `npm test` runs the fast unit suites: the core, the app's pure logic and the
  workspace scripts.
- `npm run e2e` drives the built app against a throwaway vault, and against a
  local fake Jira for the push. It is slow, opens real windows, and stays out of
  CI.

[CI](.github/workflows/ci.yml) runs a core build, the typecheck and the unit
tests on Node 22 and 24, plus a full build. It runs on Windows only, because
that's the only platform the app is used on. `main` is protected: all three
checks must pass before a pull request merges.

---

## Documentation

| | |
|---|---|
| [`GETTING-STARTED.md`](GETTING-STARTED.md) | Running it on a machine that has never seen it |
| [`SCHEMA.md`](SCHEMA.md) | The data model and the rules that hold it together |
| [`PLAN.md`](PLAN.md) | What was built, phase by phase, and why each call was made |
| [`IDEAS.md`](IDEAS.md) | Unscheduled ideas, newest first |
| [`PLAN-LINKS.md`](PLAN-LINKS.md) | The design for OneDrive-aware links |
| [`PACKAGING.md`](PACKAGING.md) | Moving a working copy, and the plan for a real `.exe` |

---

## License

MIT — see [`LICENSE`](LICENSE).
