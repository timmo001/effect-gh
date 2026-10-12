# effect-gh

An Effect v4 SDK for the GitHub CLI (`gh`).

Inspired by the Effect-native API in
[dmmulroy/herdr-ts-sdk](https://github.com/dmmulroy/herdr-ts-sdk).

## Requirements

- Effect matching `peerDependencies.effect` in [package.json](package.json), with
  a compatible consumer-chosen platform adapter.
- GitHub CLI 2.97.0 or later, installed and authenticated through `gh auth login`
  or its standard token environment variables. `Api.raw`, `Api.text`,
  `Api.empty` and `PullRequest.diff` pass `--allow-escape-sequences`, which
  older releases reject.
- An ESM consumer. Bun runs the TypeScript source directly; Node uses the compiled
  JavaScript in a built package. The platform adapter stays a consumer dependency.

## Install

The commands below read Effect and Node adapter versions from the installed SDK's
`package.json`. The Node adapter also works in Bun.

### Bun

Run from your application directory:

```sh
bun add github:timmo001/effect-gh
bun add "effect@$(bun -p 'require("@timmo001/effect-gh/package.json").peerDependencies.effect')" \
  "@effect/platform-node@$(bun -p 'require("@timmo001/effect-gh/package.json").devDependencies["@effect/platform-node"]')"
```

Commit `package.json` and `bun.lock` in your application to preserve the resolved
GitHub revision and dependency versions. The `bun` export resolves to
`src/index.ts`, and types resolve to the same source. GitHub installs need no
build step or consumer patch.

### Node

Run from your application directory to build and install a package from source
with the [mise](https://mise.jdx.dev/getting-started.html)-pinned tools:

```sh
git clone https://github.com/timmo001/effect-gh.git .effect-gh
(
  cd .effect-gh &&
    mise install &&
    mise run install &&
    mise exec -- npm pack --pack-destination ..
)
bun add ./timmo001-effect-gh-*.tgz
bun add "effect@$(bun -p 'require("@timmo001/effect-gh/package.json").peerDependencies.effect')" \
  "@effect/platform-node@$(bun -p 'require("@timmo001/effect-gh/package.json").devDependencies["@effect/platform-node"]')"
```

Keep the archive with your application for repeatable installs. The `.effect-gh`
checkout is only needed to build it.

The first npm publication is pending. After publication, either runtime can
install directly from npm:

```sh
bun add @timmo001/effect-gh
bun add "effect@$(bun -p 'require("@timmo001/effect-gh/package.json").peerDependencies.effect')" \
  "@effect/platform-node@$(bun -p 'require("@timmo001/effect-gh/package.json").devDependencies["@effect/platform-node"]')"
```

### GitHub authentication

Install [GitHub CLI](https://cli.github.com/) separately, then authenticate:

```sh
gh auth login
gh auth status
```

For automation, supply `GH_TOKEN` or another gh-supported authentication
configuration through the environment. The SDK uses it without a separate login.

## Agent skill

[The effect-gh skill](https://github.com/timmo001/effect-gh/blob/main/skills/effect-gh/SKILL.md)
guides Effect integrations towards the package and its current documentation.
It follows the [Agent Skills specification](https://agentskills.io/specification).
Install it with:

```sh
npx skills add timmo001/effect-gh
```

Or import the complete `skills/effect-gh/` directory unchanged into your skill
collection; it has no client-specific configuration or local path dependencies.

## Core SDK

`Gh` is the service tag. `layer(options?)` captures the consumer-provided
`ChildProcessSpawner` and starts no processes until an operation runs. Consumers
choose their platform layer and runtime. For example, with `@effect/platform-node`:

```ts
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Schema } from "effect";
import { Gh, layer } from "@timmo001/effect-gh";

const ghLayer = layer({ timeout: "30 seconds" }).pipe(
  Layer.provide(NodeServices.layer),
);

const program = Effect.gen(function* () {
  const gh = yield* Gh;
  return yield* gh.json(
    ["api", "user"],
    Schema.Struct({ login: Schema.String }),
  );
}).pipe(Effect.provide(ghLayer));
```

- `execute(args, options?)` returns `{ stdout, stderr, exitCode }` on exit zero.
  It buffers both UTF-8 outputs in memory, so use `stream` for large output.
- `json(args, schema, options?)` decodes stdout as JSON through the supplied
  Schema, preserving its decoding service requirements. Supply any `--json`
  fields required by the selected `gh` command yourself.
- `stream(args, options?)` emits `{ _tag: "Stdout" | "Stderr", text }` chunks.
  It drains both pipes concurrently with backpressure and preserves order within
  each pipe, with no ordering guarantee between pipes. Chunk boundaries are not
  line boundaries. Completion waits for both pipes and a successful exit.
- `interactive(args, options?)` runs on the terminal's stdin, stdout and stderr,
  without the SDK's prompt and colour overrides, so gh and git can show progress
  and ask for credentials. Output is not captured; a nonzero exit fails with
  `GhCommandError`.

Prefer the typed operations below. Reach for the raw methods only for a command
the SDK does not cover yet, and add a typed operation for it when it sticks.

`GhOptions` accepts `executable` (default `gh`), `cwd`, `env`, `stdin` (string or
`Uint8Array`), `timeout` (an Effect duration) and `maxOutputBytes`, which stops a
command with `GhOutputLimitError` once stdout passes that size. Call options override layer
defaults; environment entries merge. `timeout: null` disables a layer timeout.
Timeouts cover spawning, execution and output draining, rather than idle time.
There is no timeout by default. Schema decoding runs after the subprocess timeout.

Commands pass literal argv without a shell. The platform inherits the environment,
including existing `gh` authentication and configuration. Supplied environment
entries override inherited values; `undefined` removes a value. The SDK always
disables prompts, colour, forced TTY and spinners, and selects `cat` as the pager.
Stdin is closed unless supplied explicitly. No operation is automatically retried.

Errors are tagged `GhCommandError` (nonzero exit with exit code, stdout and
stderr), `GhPlatformError` (spawn or pipe failure), `GhTimeoutError`,
`GhOutputLimitError`, `GhDecodeError` (invalid JSON or a schema mismatch), or
`GhInvalidOptionsError` (operation options rejected before spawning). Command errors retain only
the last 65,536 UTF-16 code units of each output and flag truncation with
`stdoutTruncated` and `stderrTruncated`.
The stream emits trailing output before reporting a nonzero exit.

Interruption, timeout and early stream termination close the child scope. The
platform terminates the child, escalating after one second if needed. An early
consumer stop does not validate the final exit code. Interruptions remain Effect
interruptions rather than being converted into SDK errors.

## API requests

`Api.json(request, schema)` decodes one JSON response. `Api.empty(request)` runs
a request whose body is not needed, such as a 204 mutation. `Api.text(request)`
returns the body as text, for raw file contents and other non-JSON media types.
`Api.headers(request)` returns the response headers with lower-cased names; use
method `HEAD` to skip the body. `Api.raw(request)` returns the buffered output
and exit code. Every request specifies a method, which the SDK passes
explicitly to `gh api`. `raw`, `text` and `empty` return non-JSON bodies
verbatim, including terminal escape sequences that piped gh would otherwise
refuse; gh sanitises JSON responses either way.

```ts
import { Api } from "@timmo001/effect-gh";
import { Schema } from "effect";

const viewer = Api.json(
  { endpoint: "user", method: "GET" },
  Schema.Struct({ login: Schema.String }),
);

const subscription = Api.empty({
  endpoint: "notifications/threads/123/subscription",
  method: "PUT",
  body: { ignored: true },
});
```

Requests accept `hostname`, `headers`, `query`, a JSON `body`, and core overrides
under `options`. Query values are URL-encoded; arrays repeat the key. JSON bodies
go through stdin rather than CLI field interpolation. Bodyless calls clear any
layer-level stdin.

`Api.pages(request, pageSchema)` runs a bodyless REST GET with
`--paginate --slurp`. The result is an array of decoded **pages**, not flattened
items: use an array schema for array endpoints, or an object schema for envelopes
such as `{ workflow_runs: [...] }`. It buffers all pages and does not provide a
snapshot-consistency guarantee. GraphQL cursor pagination remains available
through the raw `Gh` interface.

### Retries

No SDK operation retries automatically. Mutations can have taken effect even
when the CLI times out or loses the connection, so only retry known-idempotent
reads, and do not transparently replay a stream after it has emitted output.

`Gh.retryTransient(options?)` retries an effect failing with `GhError` while
`isTransient` holds: timeouts, rate limits, HTTP 408, 429 and 5xx gateway
statuses, and network failures. It defaults to three retries with jittered
exponential backoff from 250 milliseconds, capped at 10 seconds
(`defaultRetrySchedule`); pass `schedule` or `times` to change either. Decode
errors, authentication failures and check-status exits are not transient.

```ts
import { Api, Gh } from "@timmo001/effect-gh";
import { Schema } from "effect";

const viewer = Api.json(
  { endpoint: "user", method: "GET" },
  Schema.Struct({ login: Schema.String }),
).pipe(Gh.retryTransient({ times: 2 }));
```

`isRateLimited(error)` and `httpStatus(error)` expose the same classification
for consumers mapping `GhError` into their own errors.

### Rate limits

`RateLimit.get(resource?, options?)` reads the `core` (default), `graphql` or
`search` quota from `gh api rate_limit`, which does not count against it.
`RateLimit.cached(timeToLive, options?)` builds an Effect `Cache` of those reads
keyed by resource. Failed reads are not kept, and `Cache.invalidate` forces a
fresh read after a rate-limited failure. `RateLimit.guard(cache, options?)`
checks that cache before a request: once remaining requests drop to
`minRemaining` (default 0) it sleeps until the reset when that is within
`maxWait` (default 60 seconds), and otherwise fails with `RateLimitExhausted`.

## Repository and issues

```ts
import { Issue, Repository } from "@timmo001/effect-gh";

const repository = Repository.view("owner/repo");
const issues = Issue.list({ repo: "owner/repo", state: "open", limit: 50 });
const issue = Issue.view(42, { repo: "owner/repo" });
```

`Repository.view(repo?, options?)` returns the repository name, URL, privacy and
nullable default branch. Omitting the selector uses gh's working-directory
context. Issue list/view also accept an optional `repo`, plus core execution
options as their final argument. Lists default to 30 open issues, and support
state, limit, labels, assignee and search filters. `Issue.view` includes the body.
Invalid numeric limits and selectors fail with `IssueInvalidInput` before spawning.

`Issue.get` and `Issue.query` take a `fields` tuple, such as
`["number", "body", "labels", "comments"]`, and decode exactly those fields.
`Issue.create` returns the new issue's URL; `edit`, `comment` and `close` cover
the common mutations.

`Repository.clone` captures output, so pass non-interactive git settings in
`env`. `Repository.cloneInteractive` clones on the terminal. Both accept extra
`gitArgs`. `Repository.browse` opens a repository or one of its sections.

## Pull requests

```ts
import { PullRequest } from "@timmo001/effect-gh";

const pullRequests = PullRequest.list({ repository: "owner/repo" });
const pullRequest = PullRequest.view(42, { repository: "owner/repo" });
const checks = PullRequest.checks(42, {
  repository: "owner/repo",
  required: true,
});
```

Pull request options require `repository` and accept core execution overrides.
Lists default to 30 open PRs, with optional state, limit, base and head filters.
List/view return number, title, URL, state, draft status, head branch and head SHA.

`PullRequest.checks` returns `{ checks, status, exitCode }`. Valid check output
from exits 0, 1 and 8 is data with status `success`, `failure` or `pending`.
Genuine command failures retain their typed error; no command is re-executed to
retrieve its output.

`PullRequest.get` and `PullRequest.query` take a `fields` tuple and decode
exactly those fields, including body, author, merge state, review decision,
comments, reviews and labels. `get` defaults to the working directory's current
branch and repository. `create` returns the URL; `edit`, `merge` (now or
`auto`), `disableAutoMerge` and `diff` cover the rest. `diff` returns the patch
verbatim, escape sequences included.

## Workflow runs

```ts
import { Workflow } from "@timmo001/effect-gh";

const runs = Workflow.list({ repo: "owner/repo", branch: "main", limit: 20 });
const run = Workflow.view({ repo: "owner/repo", runId: 123, attempt: 2 });
const logs = Workflow.logs({
  repo: "owner/repo",
  runId: 123,
  attempt: 2,
  failedOnly: true,
});
const progress = Workflow.watch(
  { repo: "owner/repo", runId: 123, interval: 3 },
  { timeout: null },
);
```

Workflow operations require `repo` and accept core options as a final argument.
Lists default to at most 20 runs, with branch, commit, workflow and status filters.
Run data uses gh's camelCase JSON fields, including `databaseId` and `attempt`.
Log retrieval supports an explicit attempt and job, and returns buffered text.
Invalid selectors and numeric options fail with `GhInvalidOptionsError`.

`Workflow.watch` emits core stdout/stderr chunks using
`gh run watch --compact --exit-status`. It defaults to a three-second refresh
interval, fails when the run fails and inherits the core timeout. It requires a
gh version with `--compact` support; gh watch does not support fine-grained PATs.
Use REST page schemas through `Api` when a consumer needs snake_case fields,
page envelopes or attempt-specific jobs.

`Workflow.jobs` returns a run's jobs and steps. `Workflow.dispatch` starts a
`workflow_dispatch` run with an optional ref and string inputs, and
`Workflow.open` opens a run in the browser.

## Auth, extensions, labels, releases and search

- `Auth.status(hostname?)` and `Auth.hasToken(hostname?)` return booleans.
  `hasToken` drains the token without keeping it. `Auth.scopes(hostname?)`
  returns the classic OAuth scopes from the `x-oauth-scopes` header, or `None`
  for fine-grained tokens.
- `Extension.list` parses `gh extension list` into name, repository and version.
  `Extension.install` and `Extension.upgradeAll` accept `{ interactive: true }`.
- `Label.create` (with `force` to update) and `Label.remove`.
- `Release.view` decodes selected fields, `Release.exists` checks a tag, and
  `create`, `edit`, `upload` and `download` cover publishing.
- `Search.code` returns matching paths with their repositories.
- `Cli.version` returns the installed gh version.

## Consumer examples

- [Notifications](https://github.com/timmo001/effect-gh/blob/main/examples/notifications.ts): nullable notification fields,
  single-page counts, mark-read/done and subscription requests with empty
  responses, plus consumer-side NodeServices composition.
- [Workflow runs](https://github.com/timmo001/effect-gh/blob/main/examples/workflow-runs.ts): REST page envelopes, branch and SHA
  filtering, retained run attempts, attempt-specific jobs and failed logs.

These examples are typechecked and tested against fixtures matching the dotfiles
and Herdr Workflow Watch contracts. They preserve the data needed by those
consumers; filtering policy, reconciliation, completeness checks and runtime
ownership stay with the application. They are migration references, not drop-in
replacements for either existing service.

## Development

Use the tool versions pinned in [mise.toml](mise.toml) and Bun for dependencies.

```sh
mise run check ::: build
```

### Tooling drift

[tooling.yml](tooling.yml) records the gh release the SDK was last reviewed
against, and [tooling/gh](tooling/gh) holds a snapshot of the help and `--json`
fields of every wrapped command at that release. The daily **Tooling drift**
workflow runs `mise run tooling:publish`, the
[tooling-drift](https://github.com/timmo001/tooling-drift) tool pinned in
[mise.toml](mise.toml). It compares the reviewed release with the latest
[cli/cli](https://github.com/cli/cli/releases) release and, when it moves, runs
`mise run tooling:refresh <tag>` to regenerate the snapshot from that release,
then opens one pull request: `[Pin-only] Update cli/cli to <tag>` with squash
auto-merge when the snapshot is unchanged, or `Update cli/cli to <tag>` for
review when a flag or field changed. Review that diff against the wrappers in
`src/` before merging; a change here may also need one in the repositories that
use the SDK.

Run the same update by hand with `mise run tooling:update <tag>`, which
downloads that gh release through
[scripts/gh-contract.ts](scripts/gh-contract.ts), regenerates the snapshot and
records the tag; `mise run tooling:status` prints whether a newer release
exists. Add a command to the list in that script when the SDK starts wrapping
it.

## Releases

To inspect the package locally, run `mise exec -- npm pack --dry-run`; the pack
hook builds `dist/`.
The package includes only the ESM build, declarations, README, licence and package
metadata.

Before the first automated publication, configure npm trusted publishing for
`timmo001/effect-gh` and workflow filename `release.yml`. An initial package
publication may be needed before that configuration is available. The release
workflow uses the shared npm publisher and resolves Bun and Node versions from
`mise.toml` through mise.

For a release, set the package version, keep `bun.lock` in sync, and pass
`mise run check` and `mise run build`. Commit and push the reviewed version, then
publish a GitHub release with a tag matching the version exactly, such as `0.1.0`.
The publisher verifies the tag against the package version, validates and builds
the package, then publishes to npm with provenance.
