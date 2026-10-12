---
name: tooling-drift
license: Apache-2.0
compatibility: Requires Git, an authenticated GitHub CLI, mise and the @timmo001/tooling-drift tool pinned in the repository's mise config, with Node.js to run it.
description: Keep a repository reviewed against the releases of the tools it wraps, configures or forks, recorded in its tooling.yml. Use when a tool a repository depends on has a new release, when checking or recording which release a repository was last reviewed against, when handling an "Update <owner>/<repo> to <tag>" pull request, or when adding tooling drift to a repository.
---

# Tooling Drift

A repository that wraps a tool (effect-gh wraps `gh`, effect-herdr wraps
Herdr's socket API), configures it (dotfiles configures Herdr and Omarchy) or
replaces parts of it with its own versions drifts when that tool releases.
`tooling.yml` at the repository root records each tool's GitHub repository
and the release tag last reviewed; the `tooling-drift` CLI, pinned with mise,
compares that with the latest release and opens one pull request per tool that
moved. The tool is the thing itself, Herdr for effect-herdr, not the SDK
fork's upstream; fork syncing is a separate workflow.

Two kinds of tool entry:

- With an `update` command, the repository derives something from the tool
  (effect-gh snapshots `gh --help` output and `--json` fields; effect-herdr
  bundles Herdr's API schema and regenerates wire types). The CLI runs it at
  the new release. Nothing but the pins changed: `[Pin-only] Update <repo> to
<tag>`, squash auto-merge. Anything else changed: `Update <repo> to <tag>`,
  for review.
- Without one, the repository depends on the tool's behaviour (dotfiles' Herdr
  and Omarchy configuration and custom plugins). Every release gets `Update
<repo> to <tag>` for review.

The skills repository tracks tool releases per skill through `skills.yml` and
`skill-reviews` instead; `check-skill-updates` owns that.

## Check

Run `mise run tooling:status`. It prints each tool's reviewed and latest
release and exits non-zero when one is behind. Without the tool, compare
`reviewed` in `tooling.yml` with `gh release view --repo <repo> --json tagName`.

## Review a release

1. Read the release notes from the reviewed tag up to the latest, with
   `gh release view <tag> --repo <repo>` for each tag in between.
2. For a tool with an update command, run `mise run tooling:update <tag>` (or
   `tooling-drift update <repo> <tag>` when the repository lists several) and
   read the diff it leaves. For effect-gh, check each changed snapshot under
   `tooling/gh/` against the wrapper in `src/` that uses that command, flag or
   `--json` field. For effect-herdr, run `mise run check`; adapt the SDK where
   the new schema breaks it, and update the README protocol notes and
   `docs/sdk-v1-parity.md` to match.
3. For a tool without one, check the areas named in the entry's `review` line
   against the notes: configuration, plugins the repository replaces or
   extends, and code that drives the tool. Then run the update command above,
   which only records the tag.
4. A change in an SDK may need a matching change where it is used: dotfiles
   (`dot`), skills (`skill-maintenance`) and the other repositories listed
   under `effect-gh` and `effect-herdr` in skills' `consumers.yml`. Say so in
   the pull request or open the follow-up there.
5. Commit with the pull request title as the subject. The workflow opens the
   pull request on `tooling/<owner>-<repo>` with `mise run tooling:publish`;
   when it already opened one, push the review changes to that branch and
   merge there. Commit and push only when asked.

## Adopt in a repository

1. Pin `npm:@timmo001/tooling-drift` in `mise.toml` and add the
   `tooling:status`, `tooling:update` and `tooling:publish` tasks from the
   tool's README.
2. Write `tooling.yml` from the README. Record the release the repository
   works with today as `reviewed`; the first run opens the pull request for
   anything newer.
3. For a derived contract, write the refresh as an Effect script run by a
   `tooling:refresh` mise task that takes the tag, depends on `install`, and
   declares a later step such as code generation with `depends_post`. Set the
   tool's `update` to `mise run tooling:refresh`. No shell scripts, and no
   command chains in one task.
4. Add [workflow.yml](references/workflow.yml) as
   `.github/workflows/tooling-drift.yml`; it calls the shared workflow in
   timmo001/workflows, which runs `mise run tooling:publish` daily. With the
   default token the pull requests cannot trigger CI, so the tool dispatches
   the workflows under `dispatch`; a `TOOLING_DRIFT_TOKEN` secret with
   contents, pull requests and actions write access lets them trigger CI
   themselves. Enable auto-merge on the repository, or the run warns and
   leaves pin-only pull requests for a manual merge.

## Safety

- Move `reviewed` through the tool, never by hand, and only after the review
  it records.
- Never enable auto-merge on a review pull request, and never merge one
  without the review.
- Regenerate derived files with the repository's own refresh task; do not
  edit snapshots, bundled schemas or generated code by hand.
