# Reading a meeting: signals and hard cases

How to sort what people said into the buckets in `SKILL.md` §3, and the cases
where the obvious reading is wrong. Cited rather than repeated in the skill
because it is reference you consult mid-transcript, not a procedure.

## Signal phrases

These are tells, not rules — read the sentence, not the keyword.

| Bucket | Typical phrasing |
|---|---|
| Action | "I'll…", "can you…", "Priya's going to…", "let's get X to Y by…", "next step is…", "we need to…" (the last one has no owner — see below) |
| Decision | "we agreed…", "let's go with…", "decision is…", "we're not going to…", "that's settled" |
| Status change | "that's done / shipped / live", "it's blocked on…", "we're dropping…", "started on that yesterday" |
| Date change | "pushed to…", "moved up to…", "can't make Friday, how about…", "now due…" |
| Progress | "we got…", "still waiting on…", "about halfway", "ran into…", "numbers look…" |
| New work | An action with no matching open item, or a deliverable nobody has mentioned before |

## Hard cases

### "We need to…" is not an action with an owner
"We need to update the dashboard" names work but no one. It is a task with an
unresolved owner: draft it, flag `⚠ owner not stated`, and ask. Do not give it
to whoever happened to speak next, and do not give it to the user because they
are the one reading the plan.

### "I" and "me" are the transcript's speaker, not necessarily the user
In a multi-speaker transcript, "I'll send it" belongs to whoever said it. Resolve
the speaker before resolving the owner. If the user is the only speaker (a voice
memo to self), "I" is the user, and the owner is the user's name from the roster.

### A first name is not an identity
"Dan" resolves to a roster entry only if it matches exactly one. Two Dans, or none
on the roster, and the name goes into the plan as a question. For `assignee` it
does not go into the field unconfirmed, because an assignee is what a push to Jira
actually sends.

### Dates are relative to the meeting, not to today
"By Friday" in a meeting dated 2026-10-06 (a Tuesday) is 2026-10-09, even if the
transcript is being processed a week later. "Next week" is the week after the
meeting. Say which date you resolved to, and note it in the plan when the meeting
is more than a day or two old, because the resolved date may already be past.

A date in the past after resolving is a sign the meeting was old: ask rather than
create an overdue item.

### "Done" has three distinct meanings in speech
- "It's done" — the work happened: `done`, if it is unambiguous and the item is
  not recurring.
- "We're not doing that" — the work will not happen: `disregard`, not `done`.
- "I did the daily check" — a recurring item was ticked: `vault_tick_item`.

When the phrase falls short ("almost", "basically", "should be fine"), log it as a
comment and do not move the status.

### Two matches, equal weight
The same topic can sit under two projects, or an epic and an unrelated task can
share a word. When two candidates fit, list both with their keys and summaries in
the plan, and write to neither. This is the one case where asking beats drafting,
because a wrong match is not reversible in the vault (comments), and nobody goes
looking for a log entry on the wrong item.

### The same item discussed twice
People return to topics. Fold it into one comment on the item, in the order the
points settled, rather than two lines that disagree. If they disagree because the
decision changed mid-meeting, record the final one and say it changed.

### Reported speech and other people's work
"Dan said the report is out" is progress on Dan's item, reported second-hand.
Record it attributed ("Dan reported the report is out") and leave the status alone
unless the transcript is the item's owner speaking. If it would change a status,
propose it and mark it as second-hand.

### Things said off the record
Anything flagged "between us", "don't write this down", or "off the record" is
never recorded, whatever its content. List only that something was omitted, not
what.

## Sizing a plan

A plan with more than about fifteen proposals is a sign something is wrong, usually
that the meeting touched many things lightly. Keep every proposal numbered and
individually decidable, but shorten the routine ones: show a `[COMMENT]` as its
`Update`/`Decided`/`Next` lines only, and put the full drafts and evidence on the
proposals that edit a field, create an item, or need a decision. The user can
always say `show 4 in full`, and the "approve all comments" and "deny all creates"
forms exist so a long plan does not mean a long reply.

If one transcript clearly covers several unrelated areas, process the largest
area in full and offer the rest as a second pass, rather than a plan too long to
read.

## What a good comment looks like

```
Meeting 2026-10-06 · Reporting weekly sync (Plaud)
- Update: provider data pulled; M&M figures wait on Finance (expected Thu).
- Decided: drop the quarterly trend page from this cycle.
- Next: Priya sends the draft by Fri 2026-10-09.
```

- First line is the tag, exactly `Meeting <date> · <title>`; it is the duplicate
  check, so do not vary it.
- `Update`, `Decided`, `Next` are the only labels, and each appears only if there
  is something under it. A comment with one line of progress is fine.
- Names, not speaker labels. Dates written out, not "Friday".
- No quoted transcript beyond a few words, and nothing in it that the user would
  not want in a permanent record.
