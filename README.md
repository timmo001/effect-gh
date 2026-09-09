# effect-gh

An Effect v4 SDK for the GitHub CLI (`gh`).

Inspired by the Effect-native API in
[dmmulroy/herdr-ts-sdk](https://github.com/dmmulroy/herdr-ts-sdk), with tooling
based on [herdr-workflow-watch](https://github.com/timmo001/herdr-workflow-watch)
and [dotfiles](https://github.com/timmo001/dotfiles).

## Requirements

- Effect `4.0.0-rc.112`, with a matching consumer-chosen platform adapter.
- GitHub CLI installed and authenticated through `gh auth login` or its standard
  token environment variables. CLI contracts are tested against gh `2.100.0`.
- An ESM consumer. The package exports JavaScript and TypeScript declarations
  from its root; the platform adapter stays a consumer dependency.

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

`GhOptions` accepts `executable` (default `gh`), `cwd`, `env`, `stdin` (string or
`Uint8Array`) and `timeout` (an Effect duration). Call options override layer
defaults; environment entries merge. `timeout: null` disables a layer timeout.
Timeouts cover spawning, execution and output draining, rather than idle time.
There is no timeout by default. Schema decoding runs after the subprocess timeout.

Commands pass literal argv without a shell. The platform inherits the environment,
including existing `gh` authentication and configuration. Supplied environment
entries override inherited values; `undefined` removes a value. The SDK always
disables prompts, colour, forced TTY and spinners, and selects `cat` as the pager.
Stdin is closed unless supplied explicitly. No operation is automatically retried.

Errors are tagged `GhCommandError` (nonzero exit with exit code and stderr),
`GhPlatformError` (spawn or pipe failure), `GhTimeoutError`, or `GhDecodeError`
(invalid JSON or a schema mismatch). Command errors retain only the last 65,536
UTF-16 code units of stderr and flag truncation with `stderrTruncated`.
The stream emits trailing output before reporting a nonzero exit.

Interruption, timeout and early stream termination close the child scope. The
platform terminates the child, escalating after one second if needed. An early
consumer stop does not validate the final exit code. Interruptions remain Effect
interruptions rather than being converted into SDK errors.

## API requests

`Api.raw(request)` returns buffered output, including empty or non-JSON responses.
`Api.json(request, schema)` decodes one JSON response. Every request specifies a
method, which the SDK passes explicitly to `gh api`.

```ts
import { Api } from "@timmo001/effect-gh";
import { Schema } from "effect";

const viewer = Api.json(
  { endpoint: "user", method: "GET" },
  Schema.Struct({ login: Schema.String }),
);

const subscription = Api.raw({
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
when the CLI times out or loses the connection. Consumers can apply Effect
`Schedule` and `Effect.retry` to known-idempotent reads with a bounded policy and
their own transient-error classification. Decode errors, authentication failures
and check-status exits are not transient errors. Do not transparently replay a
stream after it has emitted output.

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
Invalid selectors and numeric options fail with `WorkflowInvalidOptions`.

`Workflow.watch` emits core stdout/stderr chunks using
`gh run watch --compact --exit-status`. It defaults to a three-second refresh
interval, fails when the run fails and inherits the core timeout. It requires a
gh version with `--compact` support; gh watch does not support fine-grained PATs.
Use REST page schemas through `Api` when a consumer needs snake_case fields,
page envelopes or attempt-specific jobs.

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

Use the tool versions pinned in `mise.toml` and Bun for dependencies.

```sh
mise run install
mise run check
mise run build
```

## Releases

Version `0.1.0` is prepared for its first npm publication. To inspect the package
locally, run `mise exec -- npm pack --dry-run`; the pack hook builds `dist/`.
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

## Implementation checklist

- [x] Define the SDK service, layers and typed errors.
- [x] Add scoped `gh` subprocess execution with explicit working directory,
      arguments, environment, cancellation and timeouts.
- [x] Reuse `gh` authentication and decode JSON responses with Effect Schema.
- [x] Wrap `gh api`, including pagination and explicit request methods.
- [x] Add repository, pull request, issue and workflow operations needed by consumers.
- [x] Define streaming output and watch operations.
- [x] Define retry behaviour without replaying unsafe mutations.
- [x] Add focused contract tests and usage examples.
- [x] Verify compatibility with dotfiles and Herdr Workflow Watch contracts.
- [x] Prepare package exports, releases and publication.
