# Changelog

All notable changes to the app, the `vault` CLI and the MCP server. They share
one version: the three packages are built and shipped together, and
`scripts/versions.mts` fails the test suite if their `package.json` files
disagree.

The format follows [Keep a Changelog](https://keepachangelog.com/). Until 1.0.0
the version is pre-1.0 semver: 1.0.0 is reserved for freezing the vault file
format (`SCHEMA.md`) and the MCP tool names and shapes.

## [0.9.0] - 2026-10-01

The first numbered release. Everything from the initial 0.1.0 scaffold up to
this point is summarised here rather than reconstructed version by version; the
merged pull requests (#1 to #82) are the detailed record.

### Added

- **Jira push.** The app pushes items to a Jira project and updates the ones that
  have changed since, from a push pane with a preview first. The Jira mapping,
  extra fields and people are set in the app, credentials are stored once, and
  Test connection proves the pair. A fake Jira backs the end-to-end tests.
  `vault jira discover` finds a project's field ids. Select, multi-select,
  version and component fields take a choice from Jira's own list.
- **Views.** A calendar beside the agenda (drag a chip to reschedule), board
  swimlanes by project, a type filter on the backlog and board, collapsible
  subtrees, and columns that hide when their filters leave them empty.
- **Editing.** Description and comment editors, a new child from the open item,
  a reporter and an assignee menu, clickable links, markdown descriptions, zoom,
  and a chosen light or dark theme with identity colours checked against both.
- **History.** A history view over the vault's git log, turned on from a button,
  showing what changed.
- **Links and attachments.** OneDrive-aware links that stay in OneDrive, and
  attachments that survive a reload mid-batch.
- **MCP server.** 29 tools, with server instructions, `vault_unlink_item`, and one
  failure shape for every tool.
- **Bulk work.** Bulk create from CSV that carries the whole item, bulk update,
  and recurring work completed with a tick.
- **Claude drafting.** In-app drafting of an item from a sentence, and capture
  that splits an ask into its deliverables.
- **Skills for this repo**, `vault-capture` and `vault-update`, plus the git
  workflow skills.
- **Getting it running.** `bootstrap.ps1` that finishes in one run, a numbered
  launcher menu, a launcher with no terminal, a desktop shortcut, a check for
  whether an update is due, and update and install options in the menu.
- **CI** that runs the test suite on every push.
- **Version.** The app reports its version over IPC (`app:version`) from
  `package.json`, for the sidebar title row. A test keeps the three
  `package.json` versions equal.

### Changed

- The window and page title is "ToDo Vault", from one constant.
- Dependencies are refreshed to their patches and `npm install` reports no
  vulnerabilities. Update installs from the lockfile.
- A move never overwrites a racing create, and two creates never share a key.

### Fixed

- A pasted, quoted vault path still resolves.
- The history panel hides again when asked.
- One launch opens one window.
