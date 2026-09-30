# Future ideas

Unscheduled ideas that haven't earned a PLAN.md phase or a PLAN-*.md design doc
yet. When one is ready to build, promote it: either a new phase in PLAN.md, or
its own `PLAN-<name>.md` if it needs real design work first (see PLAN-LINKS.md
for the shape of one of those).

Newest at the top. No status tracking here — once something's picked up, its
entry moves out to wherever it's being built.

## Two processes creating at once can be handed the same key

Measured while building the single-instance lock (PLAN.md, "One launch, one
window"). Six creates fired together from two app windows came back as `OPS-6,
OPS-6, OPS-7…`, both calls reported success, and the first `OPS-6` was silently
overwritten. `allocateKey` reads `.counters.json`, increments it and writes it
back, and nothing guards that sequence across processes. `VaultService`'s queue
only serializes within one.

The lock closed the easy way to reach this, but not the only one. The app, the
MCP server and the CLI are still three processes over one vault. The narrowest
fix is in the core: have the item write refuse to replace a key file that
already exists (`wx`, the exclusive-create flag) and retry allocation on
`EEXIST`. Losing the race then costs a retry instead of an item. A lockfile
around the whole allocation also works, but on Windows it brings stale-lock
recovery with it.

## The command palette finds things but cannot do anything

`CommandPalette.tsx` searches two kinds of row, projects and items, and opening
one is the only thing it can do. Every edit still goes through the detail panel
or a single-key shortcut, and nothing lets you type an action and have the
palette find it. The usual next step for a palette is verbs: *set due…*, *move to
status…*, *assign…*, *tick*, *open History for this item*. Each one applies to
the selected item, or to the checked set when bulk selection is active.
`BulkBar` already defines what a multi-item edit means, so the palette would be a
second way into edits that already exist, not a new write path.

The design question is how a verb takes an argument. A two-step palette (pick the
verb, then pick the value from a second list) is the standard shape, and it
reuses the `Suggest` component that Reporter and Assignee already share for the
people and category fields.

## An undo for the last edit, since there is no save button to hesitate at

Every edit in the detail panel commits the moment it lands. That is the design,
and it is why there is no draft state to lose. It also means a slip of the
keyboard is written, committed and synced before you notice it. The only way back
today is to read the History view and retype the old value by hand. Nothing in
the core restores a version: `history.ts` reads the log and nothing writes from
it.

A toast that reads *"Due date changed — Undo"* for a few seconds would cover the
common case without touching git at all. The renderer already knows the field and
its previous value at the moment of the edit, so undo is a second `updateItem`
with the old value, and it lands in history as the ordinary edit it is. That is
deliberate: a `git revert` would be cleverer, but it would rewrite the file under
a watcher, fail on any vault without history, and read in the log as something
other than a person changing their mind.

What needs deciding is scope. The last edit only, or a short stack? Bulk edits
count as one undo, and `BulkBar` knows the whole set. Comments cannot be undone
at all, because the comment log has no remove (see "Removing a comment" below),
so the toast should not be offered for them.

## Say when a filter is hiding work, and remember the filters you left

The toolbar holds seven independent narrowing controls: project, status,
cadence, reporter, type chips, text, and Hide closed. Each one lives in its own
`useState` in `App.tsx`, so a restart resets all of them to defaults. That is
fine. The failure is the other direction: within a session, a type chip ticked on
the board is still silently narrowing the board an hour later, and the only
evidence is a card count that looks low. "Where did my task go" is the most
common question a filtered tracker gets, and this one does not answer it.

Two small pieces:

- **A single "N filters on · Clear" chip** beside the toolbar whenever anything
  is off its default. The board's zero-column empty state already proves the
  pattern: it names the two controls that conflict rather than drawing nothing.
- **Remembering the last filters per view** across restarts, in the settings file
  main already writes (`vaultRoot`, `zoomLevel`, theme). Per view, because the
  board filtered to one project and the backlog showing everything are both
  normal, and one shared set would fight itself.

**Saved views** are the natural third step: name a combination such as *ACME
epics, next 30 days* and reach it from the sidebar or the palette. It belongs
after the other two, because a saved view is a named copy of state that has to
exist in one serialisable shape first.

## Split the toolbar out of `App.tsx` before the next filter lands in it

`App.tsx` is 1,480 lines. Around thirty `useState`s sit at the top, and the
toolbar is a ternary on `view === "agenda"` that draws two different control
sets. Three of the entries in this file add to that ternary: the agenda type
filter, remembered filters, and saved views. The start-date and settled-recurring
filters being built now add to it too. Each one is cheap on its own and pays the
same tax: finding its place in a component that owns everything.

The extraction is mechanical, which is why it is worth doing on its own branch
first rather than folded into a feature. Move the filter state into one reducer
(or one object in `useState`) plus a `<Toolbar>` component that takes it. A
single filter-state shape is also exactly what "remember the filters" and "saved
views" need to serialise, so the refactor is the first step of both.
`ItemDetail.tsx`, at 1,111 lines, is the same shape of problem one panel over,
but nothing on the roadmap is queued behind it.

## Add a card from the column you want it in

The board has no add affordance. `n` opens the create dialog with the project
defaulted, and `+ new child` works from an open item, but a card made for the
Blocked column is made in `todo` and then dragged. A small **+** at the top of
each column (and each project lane when grouped) that opens the same dialog with
status and project pre-filled would keep one create path, not two.

One catch shapes it. `TRANSITIONS` decides which statuses a new item can start
in, and creating straight into `done` or `in_review` is either illegal or a
rollup question. The **+** should appear only on columns a new item can
legitimately start in, which is the same "impossible, not empty" reasoning the
board already uses to drop columns.

## Show which fields a Claude draft guessed

The draft box returns a filled form plus a free-text `notes` caveat. It does not
say which fields came from the sentence and which were inferred, so the reviewer
has to reread every field to find the one that was invented. The PLAN.md handoff
names this as the failure most likely to go unnoticed: a resolved date that is
wrong, a project picked by inference.

The structured-output schema is ours, so the model can return a per-field
`source: "stated" | "inferred"` alongside each value, and the dialog can mark the
inferred ones, for example a dotted underline with the reason on hover. That
turns the handoff checklist into something visible on every draft, rather than a
test someone has to remember to run. It costs a schema change in `claude.ts` and
a render pass in `CreateDialog.tsx`, and no core change, since provenance is never
written to the item.

## A weekly review: the items nobody has looked at

The agenda answers *what is due*. Nothing answers *what has gone quiet*: open
items untouched for weeks, drifted items waiting to be re-pushed, anything
`blocked` for longer than a sprint, and an epic whose children are all closed but
which is not closed itself. The data for all four already exists. Git history
gives a last-touched date per file (the History view reads it), `sync.state`
gives drift, and the rollup rules already know an epic's children.

The shape is a sixth view, or an agenda scope, that walks those lists one item at
a time with three buttons: *still relevant*, *reschedule*, *close* (or disregard).
It should not be a report, because a report only lists the work where a review
gets it done. Whether "untouched" means a commit touching the file, or only a
change to certain fields, needs deciding first. A reorder in the backlog rewrites
`rank`, and that should probably not count as looking at an item.

## A nudge when something comes due, without opening the app

Nothing in `apps/desktop/src` uses Electron's `Notification`. The agenda already
computes the overdue and due-today sections every time it renders, so a
once-a-morning *"2 overdue, 3 due today"* notification is a timer in main plus a
call into code that already exists. Clicking it opens the agenda.

What makes it harder than it looks: the app has to be running. So this is either
"only while open", which is honest and small, or it pairs with a tray entry (next
entry) so closing the window does not end the process. Settle that before
building either one. Once only, not repeating, and switchable off in settings;
a task app that nags gets muted.

## Capture from anywhere: a global hotkey and a tray entry

The fastest ways to add a task today are the CLI and an external Claude through
`vault-capture`. That skill has been through more iterations than any other part
of the capture story, which says where the friction is. Inside the app you first
have to bring the window forward. Nothing uses `globalShortcut` or `Tray`.

The shape is a system-wide shortcut that opens a small always-on-top window
holding the create dialog's draft box. One sentence and Enter drafts it with
Claude when a key is stored, or makes a bare todo when not, then the window
vanishes. A tray icon gives the same entry point to the mouse and keeps the
process alive for the notification above.

Two decisions first. Which accelerator: something like `Ctrl+Alt+Space` that no
common app claims, and remappable, since a global shortcut that collides fails
silently on Windows. And whether closing the main window now hides it to the tray
instead of quitting. That changes what the desktop shortcut and the new
single-instance lock mean by "the app is running", so it should be decided with
that lock in mind.

## Removing a comment, and detaching a copied attachment

`vault_unlink_item` closed the link half of this; the other two have no inverse
anywhere in the core, on any surface. They are not oversights but design
questions. The comment log is the item's audit trail, so whether a removed
comment leaves a tombstone or vanishes is a schema decision with a Jira-push
consequence attached. A copied attachment lives in `attachments/<key>/` and is
versioned with the item, so detaching it has to decide whether the bytes go too.
`PLAN-LINKS.md` gotcha 7 logged the attachment half when it was first noticed;
this is the same entry, still unanswered.

Until one exists, the MCP server's instructions block tells the agent to confirm
before both.

## MCP has no way to ask what git did

`doctor`, `git-status` and `history` are CLI-only, and `history` is also a
desktop view. The server's instructions block now says *whether* writes are
being committed, which answers the question that matters at the moment of a
risky write, but an agent still cannot read the history back or check whether
the working tree is clean. Worth doing as one parity pass over all three rather
than a tool at a time, since the interesting output is `history` and it needs a
projection that will not blow up a context window.

## `components` is accepted by the core and exposed by no MCP tool

`schema.ts` takes it on create and update, and `jira.ts` pushes it. Nothing on
the MCP surface can set it, and nothing anywhere says so — an absence with no
per-tool description to be missing from. The change is small. It was left out of
the instructions block deliberately: a field nobody has yet asked for does not
earn a line in every session's context. If someone asks for it twice, expose it.

## The test counts written into prose still drift, and CI does not check them

CI exists now — `.github/workflows/ci.yml`, on every pull request and every push
to `main` — so the suite is no longer run only by someone remembering to.
`PLAN.md` records what building it settled. This entry is the half of the
original idea that was never built, kept because it is still true.

The drift that motivated the whole thing was never the test run. It is prose:
`README.md`, `GETTING-STARTED.md` and `PLAN.md` all state test counts in
sentences, and those sentences go stale every time the suite grows. It had
happened twice when this was first written — `c43d414` fixed
`GETTING-STARTED.md` and missed `README.md`; PR #13 found `README.md` claiming
96 tests in 69/27 against a real 114 in 78/36 — and it has happened twice more
since, both times caught by a person reading the tree rather than by anything
automatic. A step that runs the suite, reads the totals out of the TAP summary
and fails on a mismatch would catch every one of them.

The reason it is still an idea and not a workflow step is that it is a check on
prose, and prose gets reworded. It would need maintaining in a way the test run
never does, and a check that fails because a sentence was rephrased teaches
people to ignore it. The cheaper and less satisfying alternative is to stop
putting counts in prose at all — worth pricing against the check before writing
either, since one of them is a permanent tax and the other is a one-off edit.

**Related, and verified rather than assumed: `main` is not a protected branch.**
`gh api repos/rellik92j/todo-vault/branches/main/protection` returns 404. A
workflow that runs is not a workflow that gates, so a red run today is a red X
that can be merged straight past. Turning on branch protection is a settings
change rather than a code one, which is exactly why it keeps not happening.

## Filter the agenda by item type

The backlog and the board can be narrowed to epics, or to everything except
subtasks; the agenda cannot, and it is the view where the ask bites hardest. Six
scopes now, and the long ones — `month`, `next30Days` — are where a window fills
with subtasks and the shape of the month stops being readable. "Epics only over
the next 30 days" is a roadmap; the same window unfiltered is a list.

The chips already exist and are already right. `ITEM_TYPES.map` renders them in
`App.tsx`, `types` holds the types to *keep* with empty meaning all, and
`toggleType` flips one. The comment on that state is worth reading before
redesigning anything — a set rather than a select, because "epics only" and
"everything except subtasks" are the two real asks and one dropdown can only
express the first. None of that needs to change. Two things do.

**Where the chips render.** The toolbar is a ternary on `view === "agenda"`:
the agenda branch draws the scope `<select>` and nothing else, and the chips sit
in the other branch with status, cadence, reporter and text. So they are not
hidden by CSS on the agenda — they are not mounted, and `types` keeps whatever
it was last set to. Moving the chips out of the ternary so both branches draw
them is most of the work.

**What the agenda is fed.** This is the decision, and the tempting one-liner is
the wrong answer. `Agenda` takes `items` and narrows the core's sections to the
keys it can see — the mechanism is already there, `byKey` and `populated`, and
it already drops emptied sections rather than drawing headed empty boxes, so
type filtering needs no new render logic at all. But it is passed
`visibleItems`, not `filtered`, and the comment at that call site says why: it
is the only thing keeping a hidden project's overdue work off the agenda.
Switching it to `filtered` would deliver the type filter and drag five others
along with it. Two of those are actively wrong here — `openOnly` and `status`
are meaningless on a view built from `DONE_STATUSES` already, and a status
filter of `todo` would empty the overdue section of everything in progress,
which is precisely the work someone opening the agenda wants to see. The honest
shape is a third derivation between the two: `visibleItems` plus the type
predicate, and deliberately not the rest. Whether `text` belongs in it is a fair
question — search-within-agenda is defensible — but it should be argued for, not
inherited.

Worth deciding at the same time, because the answer affects whether the counts
in the section headers can be trusted: the header count is already computed
after narrowing, so it will say "2 items" for a section the core built with
nine. That is right for a filter the user just applied and can see the chips
for, and it is the same thing project-hiding already does — but it means the
agenda's totals are a view of a view, and anything that later wants the true
window total has to ask the core rather than read the heading.

## A `nextMonth` agenda scope — the last of the three, and the only awkward one

**Done:** `twoWeeks` and `next30Days` are built (see PLAN.md, "Two more agenda
scopes"). Do not redo them. What that build changed for this entry is the price.

This entry used to open by counting the tax: `AgendaScope` was retyped by hand
in at least six places — the union in `shared/api.ts`, the zod enum in
`mcp-server.ts`, an inline cast *and* a `scopePhrase` record inside `cli.ts`,
`SCOPE_PHRASE` in `Agenda.tsx`, the `<select>` in `App.tsx` — with nothing
forcing them to agree. That is fixed. `AGENDA_SCOPES` in `constants.ts` is the
list, `AgendaScope` is derived from it, and the type flows everywhere through
imports; the `ranges` record is now `Record<AgendaScope, …>`, so a scope in the
array with no range fails the typecheck rather than arriving as `undefined`.
What is left for a new scope is four real edits — the array, the range, and two
phrase records — plus prose in `vault_get_agenda`'s description, the `<option>`,
the CLI help block, and the scope table in SCHEMA.md. One caveat if the
typecheck seems to disagree with you: the desktop workspace resolves
`todo-vault` through `packages/core/dist`, so the shared type does not reach it
until `npm run build -w todo-vault` has run.

So the remaining question is not cost, it is the one thing about `nextMonth`
that is genuinely different, and it will not show up in testing until someone
ticks a monthly item at the wrong time. `reference` in that window is neither
inside it (as it is for `today`, `week`, `month`, `twoWeeks` and `next30Days`)
nor at its start — it falls entirely *before* `from`. `nextWeek` already has
this property and already works, but for a reason that is easy to mistake for
having been designed in: `cadencePeriod` (`recurrence.ts`) always computes the
period *containing `reference`* — this week, this month — never the window being
displayed. For `nextWeek`, `isSettledForWindow` checks this week's `period.to`
against next week's `windowEnd`, and this week's end is never `>=` next week's
end, so a weekly item always reads as unsettled and correctly keeps showing up
under "Recurring next week" — right answer, but because of which direction that
inequality happens to point, not because the period was shifted forward to match
the window. `nextMonth` would inherit the identical accident: this month's
`period.to` is never `>=` next month's end, so a monthly item always shows there
too, which is again the right answer. Safe to build the same way `nextWeek` was
— but it deserves a comment saying so where the range is added, since the
obvious "fix" — computing `cadencePeriod` from the window's own `from` instead
of from `reference` — is the thing that would actually break it for every scope
that isn't this one.

On the range itself, no new date-math helper is needed even though
`recurrence.ts` has no month-shift arithmetic today (only `startOfMonth`,
`endOfMonth`, `startOfQuarter`, all reference-relative): `endOfMonth` already
composes into it — `addDays(endOfMonth(reference), 1)` is next month's start,
and `endOfMonth` of that is next month's end.

One thing to settle before building it, which did not apply when this was one
ask of three: `next30Days` now covers most of what "next month" colloquially
means, and does it from any day. `nextMonth` is worth adding for the case
`next30Days` cannot serve — planning a calendar month that has not started, the
forward twin of `month`'s rollup — and the `<select>` should be ordered and
labelled so the two do not read as synonyms.

## A drifted item still cannot be pushed as an update

Fixing the planner's eligibility check left the harder half standing: nothing in
the repo updates an existing Jira issue. `buildPushPlan` only ever creates, so a
drifted item's choices are a duplicate issue or a hand edit. The plan now says so
in a warning, which is honest, but the remedy is still manual — edit Jira, then
call `vault_mark_pushed` again to re-stamp the baseline. That call rebuilds
`sync` from scratch (`Vault.markPushed`), so it wants `jiraKey` re-supplied and
`jiraId` re-supplied too, or the id is silently dropped. No SCHEMA.md entry or
tool description says any of this. The CLI half has narrowed since this was
written: `vault jira record --from <file.csv>` (PR #53) stamps a whole import's
worth of keys from the CSV Jira exports back out. That covers the bulk-create
path. It does not cover re-stamping one hand-edited drifted item, which is still
MCP-only.

A smaller thing worth folding in whenever this is picked up: drift is one-way —
`markDriftIfChanged` moves `pushed → drifted` and never back — so an item edited
and then reverted keeps the `drifted` pill in the detail panel forever. The push
planner no longer cares, since it compares hashes rather than trusting the
label, but the UI still misreports it. Healing the label needs a rule about what
`pushed` means when nothing was pushed, which is why it sits here rather than
having been fixed alongside the hash.

One caution for whoever picks this up, kept because getting it wrong once is
instructive: this entry used to warn that `PLAN-LINKS.md` was wrong to say
adding a link flips a pushed item to `drifted`. The observation was right —
`links` was absent from `pushableFields` and `addLink` persisted without
recomputing anything — and the conclusion was backwards. Links *are* pushed, in
the description footer, so the doc described correct behaviour that had never
been built. Both halves are fixed now (see PLAN.md, "Links count as drift"): the
field list gained `links`, and the recomputation moved into `persist`, where the
writers that skip `updateItem` go through it too.

So the standing advice survives in a sharper form. Check the field list rather
than the prose — and when the two disagree, ask which one Jira would agree with
before assuming the prose is the stale half.

## A `parked` status, if Hide later turns out not to be enough

**The two filters this entry used to prescribe are built:** see PLAN.md, "The pile
can hide work that is not for today". A future-start `todo` and a recurring item
already ticked this period both drop out under the toolbar's Hide later, and
`ItemFilter` has `startBefore`/`startAfter`. The argument for building those
first — **does the item leave the state on its own, or does a person decide it
leaves?** — is recorded there too. Do not reopen "scheduled" as a status: a date
arriving is the clock, and a status for it goes stale the morning it comes true.

That leaves the one case a status genuinely fits, and it is worth asking whether
it is the real ask: *"I have decided not to look at this until later, and I will not
invent a start date to say so."* That is a decision, not a date, and nothing in
the schema records it — `blocked` is close but claims something external is in the
way. If that is what is wanted it should be named for the decision, `parked` or
`deferred`, not `scheduled`, which promises a date it does not have.

One point genuinely on the status side, since it cuts against deriving: `status`
is not in `pushableFields` but `startDate` is. Expressing "later" by typing a date
flips a pushed item to `drifted` against Jira; a status change does that only on
the one move that now writes a date — into `in_progress` — and never on a move
that means "not yet".

If it does turn out to be `parked`, the cost is not distributed the way the
`disregard` phase would suggest. Jira is free — `statusTransitions` is a
defaulted record that nothing reads yet, so an unmapped status is a doc edit.
`TRANSITIONS` is where the work actually is: a new row plus a decision in each of
six existing rows, every one the same rollup-integrity question that makes
`todo → in_review` a refusal. `DONE_STATUSES` is the trap — its comment reads "no
longer needs attention", which a parked item satisfies, but `open` must still
find it or this is `disregard` with a friendlier label; reuse silently retires the
item, and a second set means every existing caller has to say which of the two it
meant. `BOARD_ORDER` forces the choice the disregard column dodged, since
`pieces.tsx` already records that six columns overflow the default window and
that a status missing from the list makes cards vanish rather than merge — and
the grouped board now derives its grid's `--columns` from that same length, so a
seventh status widens every lane at once rather than misaligning one of them. And the
dot has to pass `--disregard`'s test — seventh hue distinguishable from six others
at 7px — while wanting to read as *quiet*, which is what `--todo`'s grey already
is.

The test for whether this is needed is using Hide later for a while. If the pile
still feels clogged with it ticked, what is left is the parked decision — visible
on its own, which is the only honest way to price a seventh status.

## OneDrive links through the MCP server, not pasted into the description

The OneDrive design is already written — `PLAN-LINKS.md` ask 2, gotchas 1–3 and
9–11, build steps 3–4, none of it built. This entry is not that design restated.
It is the one surface that design deliberately leaves out, and the reason that
exclusion is worth reopening.

**Done:** the cheapest first step, the two tool descriptions. `vault_link_item`'s
`url` line and `vault_attach_file`'s `copy` line now both name synced cloud
storage (OneDrive, SharePoint, Google Drive, Dropbox), and `SCHEMA.md`'s Links
section carries matching wording plus the capability-URL note from gotcha 11.
Text only, inside gotcha 3's ruling not to add a link type. Do not redo this —
what is left below is guidance, not a guard, and `vault_attach_file` still
defaults to `copy: true` with no guard behind the new wording.

What remains is the local-path half. Gotcha 2 rules that sync-root detection is
Windows-shaped and machine-local, so the roots get passed into the core as
`VaultOptions.syncedRoots` and the desktop main process is the thing that
discovers them. The proposed shape then says the option is "empty by default,
so CLI/MCP behaviour is unchanged", and calls that the honest outcome. It was
the right call for a doc scoped to the app. But the MCP server is arguably the
*likeliest* surface to be handed a OneDrive path — nobody drags a file into a
chat, they paste
`C:\Users\bisch\OneDrive - Contoso\Docs\plan.xlsx` as text — and with
`syncedRoots` empty, `vault_attach_file` defaults to `copy: true` and makes the
diverging second copy that ask 2 exists to prevent. The desktop app would refuse.
The agent won't, and now it has been told not to, but nothing stops it either.

Only the local-path rule needs to be told where the sync roots are, and a
headless server has no main process to ask. That is the open question this
entry is really holding: an env var, a config key, or accepting that the local
half stays app-only.

## "Turn on history" — a button that sets git up for the chosen vault

Setting up history today is a manual sequence nobody should have to know: copy a
`.gitattributes` in, `git init`, `git add -A`, `git commit`, and — the step that
actually bites — have a `user.name` and `user.email` configured first. Miss the
identity and `git add` still succeeds while `git commit` fails, and `commit()`
swallows that by design, so every write lands, none is committed, and nothing
says so. That is the one failure mode in the whole design that loses work, and
it is currently prevented only by the user knowing to prevent it.

The diagnosis half is already built and already right. The banner in `App.tsx`
distinguishes the three shapes — not a repo, sitting inside a repo that ignores
it, or a repo whose last commit errored — and the sidebar dot shows healthy or
not. What is missing is anything to click. Everything the button needs to decide
is already in the `GitStatus` the snapshot carries; what is absent is a
write-side action, since git is read-only across IPC today.

Offer it in two places: on that banner, and at the first-run picker once a folder
is chosen, since that is when the user is thinking about setup at all.

The order matters and is the reason this wants writing down rather than
improvising. `.gitattributes` (`* text eol=lf`) has to exist **before** the first
`git add`, or Windows stages CRLF while the app writes LF and every file reads as
wholly modified — which defeats the stable frontmatter ordering the diffs depend
on. Identity gets checked before `git init`, not after, and if it is missing the
button asks for a name and email rather than failing: that is two fields and the
difference between history working and silently not.

Then it must verify by *doing*, not by looking. `healthy` is false only once
`lastCommitError` has been set, and that is only ever set by a commit that
already failed, so a freshly initialized repo reports healthy whether or not
commits can actually land. Making the initial commit and confirming it is both
the setup and the proof.

Two cases where the button should explain instead of act. If git is not on PATH
there is nothing to initialize — say so and point at the download, do not offer a
button that cannot work. And if the vault sits inside a repo that ignores it,
`git init` would nest a second repo inside the first; that may well be what the
user wants, but it is a choice they should make knowingly rather than a side
effect of clicking Fix.

## A UI style guide, so the next screen matches the last one

**Half of this is done — the colour half.** This entry used to spend most of its
length on a light block that redefined twelve surface tokens and left every
identity hue behind. That is fixed and enforced: see PLAN.md, "Identity colours
are chosen against both grounds". `test/tokens.test.ts` now fails on a colour in
`:root` with no light counterpart, a hardcoded colour literal outside the token
blocks, or an identity token under 3:1 on any ground in either scheme. Do not
redo it. The twelve `rgb(0 0 0 / …)` shadows and scrims were deliberately left
as literals, with the reason recorded in the stylesheet.

What is left is the layer that was never a system at all. `index.css` is now
2,568 lines, and its padding, gap and margin values use twenty-three distinct
pixel sizes — 1 through 14 nearly continuously, then 16, 18, 20, 24, 28, 32, 40,
44, 48. `8px` is the clear favourite at 41 uses; `7px`, `9px` and `11px` sit at
17, 16 and 8, which is the signature of values nudged by eye until something
looked right rather than picked from a scale. Each is defensible alone. In
aggregate it is why two panels built a month apart feel subtly unrelated, and
every new component is a fresh guess. A short scale — `2 4 8 12 16 24 32`, as
tokens — would make the choice mechanical, and the same test file that polices
colour literals could police spacing literals once the migration is done.

Two things worth deciding alongside it rather than after:

- **The selected-row ground.** On a selected row the background becomes
  `--accent-dim` and the grey identity tokens fall to about 2.4:1 — 1.5:1 for
  `--lowest` in dark. The stylesheet records this as a question about
  `--accent-dim` as a selection colour rather than about the greys. That makes it
  a style-guide question, and the only colour issue still open.
- **Type sizes.** Font sizes are the same story as spacing and have not been
  counted. Count them before designing the scale, so one pass migrates both.

The colour thinking that is already right — `--disregard` warm on purpose, seven
hues behind ten tokens, `--in_progress` tied to `--accent` in both schemes — is
still discoverable only by reading `index.css` and PLAN.md. A short `STYLE.md`
that names the tokens, the scales and the rule for adding either would be where
someone designing the next screen actually looks.

Still probably its own `PLAN-STYLE.md` rather than a phase, but it has shrunk
from a design decision to a migration with a test at the end of it.
