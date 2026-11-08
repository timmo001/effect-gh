import { resolve } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Tool } from "@opencode/schema/tool";
import {
  AgentTask,
  Alias,
  Api,
  Attachment,
  Autolink,
  Cache,
  Codespace,
  Comment,
  Config,
  DeployKey,
  Discussion,
  Gh,
  GhCommandError,
  GhDecodeError,
  GhInvalidOptionsError,
  GhTimeoutError,
  Gist,
  GpgKey,
  Graphql,
  Issue,
  IssueArtifact,
  Label,
  layer as ghClientLayer,
  Org,
  Project,
  PullRequest,
  Release,
  Repository,
  Review,
  Ruleset,
  Search,
  Secret,
  Skill,
  SshKey,
  Status,
  Template,
  Variable,
  Workflow,
} from "@timmo001/effect-gh";
import {
  type Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Schema,
  SchemaAST,
  Struct,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  type ClientTool,
  plain,
  type PreparedCall,
  strictInput,
  tailLines,
  type ToolAccess,
  type ToolInput,
  toToolError,
} from "./tool";

const ghLayer = ghClientLayer().pipe(Layer.provide(NodeServices.layer));

/** Where one gh tool call runs. */
interface GhCall {
  /** The session directory, where gh runs. */
  readonly cwd: string;
  /** [HOST/]OWNER/REPO, or empty when the tool doesn't resolve one and none was given. */
  readonly repo: string;
}

/**
 * How a tool finds its repository: `resolve` uses `repo` or the session directory's repository,
 * `local` passes `repo` through so gh picks the repository and current branch itself, and `none`
 * has no repository.
 */
type RepoMode = "resolve" | "local" | "none";

/** A call's access and permission resource, when they depend on more than its input's shape. */
interface Classified {
  readonly access: ToolAccess;
  readonly resource: string;
}

const toGhError = (cause: unknown): Tool.Error => {
  if (cause instanceof Tool.Error) return cause;

  if (cause instanceof GhCommandError)
    return new Tool.Error({
      message: `gh exited ${cause.exitCode}\n${tailLines([cause.stderr, cause.stdout].filter(Boolean).join("\n"))}`,
      error: cause,
    });

  if (cause instanceof Graphql.ResponseError)
    return new Tool.Error({
      message: cause.errors.map((entry) => entry.message).join("\n"),
      error: cause,
    });

  if (cause instanceof Attachment.PrivateRepositoryError)
    return new Tool.Error({
      message: `${cause.repository} is private, so attachments uploaded against it 404 for everyone else. Pass a public repository, such as your fork, as uploadRepository.`,
      error: cause,
    });

  if (cause instanceof GhTimeoutError)
    return new Tool.Error({
      message: `gh timed out after ${cause.timeoutMs}ms`,
      error: cause,
    });

  if (cause instanceof GhInvalidOptionsError || cause instanceof GhDecodeError)
    return new Tool.Error({
      message: `${cause._tag}: ${String(cause.cause)}`,
      error: cause,
    });

  return toToolError(cause);
};

const currentRepository = (cwd: string) =>
  Repository.view(undefined, { cwd }).pipe(
    Effect.map((repo) => repo.nameWithOwner),
  );

const WithRepository = Schema.Struct({ repo: Schema.String });

const preview = (input: ToolInput) => {
  const text = JSON.stringify(input, null, 2);

  return text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text;
};

/** Markdown fields a tool also takes from a local file, as `<field>File`. */
const textFields = ["body", "notes"];

/** A tool input's fields, which decode without services. */
type InputFields = Readonly<Record<string, Schema.Codec<unknown>>>;

/**
 * A tool's input with `<field>File` beside each top-level Markdown field, which
 * becomes optional since either one gives it. Long text is easier to write to a
 * file than to quote in a call.
 */
const withTextFiles = (input: Schema.Struct<InputFields>) => {
  const names = textFields.filter((name) => {
    const field = input.fields[name];

    return field !== undefined && SchemaAST.isString(field.ast);
  });

  if (names.length === 0) return { names, input };

  const fields = Object.fromEntries(
    names.flatMap((name) => {
      const field = input.fields[name];

      if (field === undefined) return [];

      return [
        [
          name,
          SchemaAST.isOptional(field.ast) ? field : Schema.optionalKey(field),
        ],
        [
          `${name}File`,
          Schema.optionalKey(Schema.String).annotate({
            description: `A local file to read ${name} from instead, relative to the session directory. Pass ${name} or ${name}File`,
          }),
        ],
      ];
    }),
  );

  return { names, input: Schema.Struct({ ...input.fields, ...fields }) };
};

/** Replace each `<field>File` with the file's contents as `<field>`. */
const readTextFiles = (
  input: ToolInput,
  names: readonly string[],
  directory: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const read = yield* Effect.forEach(names, (name) => {
      const file = input[`${name}File`];

      if (!Predicate.isString(file)) return Effect.succeed([]);

      if (input[name] !== undefined)
        return Effect.fail(
          new Tool.Error({ message: `Pass ${name} or ${name}File, not both` }),
        );

      return fs.readFileString(resolve(directory, file)).pipe(
        Effect.map((text) => [[name, text] as const]),
        Effect.mapError(
          (error) =>
            new Tool.Error({
              message: `Could not read ${name}File ${file}: ${error.message}`,
              error,
            }),
        ),
      );
    });

    const fileKeys = new Set(names.map((name) => `${name}File`));

    return Object.fromEntries([
      ...Object.entries(input).filter(([key]) => !fileKeys.has(key)),
      ...read.flat(),
    ]);
  }).pipe(Effect.provide(NodeServices.layer));

/** Define a gh tool, resolving its repository before the permission check so the prompt can name it. */
const ghTool = <S extends Schema.Struct<InputFields>, A, E>(tool: {
  readonly name: string;
  readonly description: string;
  readonly access: ToolAccess;
  readonly pinned?: boolean;
  readonly timeout?: Duration.Input;
  readonly repo?: RepoMode;
  readonly input: S;
  /** The call's access and resource, for tools that read or write depending on their input. */
  readonly classify?: (
    input: S["Type"],
  ) => Effect.Effect<Classified, Tool.Error | Graphql.ParseError>;
  /** The permission resource after the tool id; the repository when unset. */
  readonly resource?: (input: S["Type"], repo: string) => string | undefined;
  readonly run: (input: S["Type"], call: GhCall) => Effect.Effect<A, E, Gh>;
}): ClientTool => {
  const text = withTextFiles(tool.input);

  return {
    name: tool.name,
    description: tool.description,
    access: tool.access,
    pinned: tool.pinned ?? false,
    timeout: tool.timeout ?? "2 minutes",
    input: text.input,
    prepare: (raw, directory) =>
      readTextFiles(raw, text.names, directory).pipe(
        Effect.flatMap((input) =>
          Schema.decodeUnknownEffect(tool.input)(input, strictInput).pipe(
            Effect.mapError(
              (error) =>
                new Tool.Error({
                  message: `Invalid input for ${tool.name}: ${error.message}`,
                }),
            ),
            Effect.flatMap((decoded: S["Type"]) =>
              Effect.gen(function* () {
                const given = Option.getOrUndefined(
                  Option.map(
                    Schema.decodeUnknownOption(WithRepository)(decoded),
                    (input) => input.repo,
                  ),
                );

                const mode = tool.repo ?? "resolve";

                const repo =
                  mode === "none"
                    ? ""
                    : (given ??
                      (mode === "resolve"
                        ? yield* currentRepository(directory)
                        : ""));

                const classified =
                  tool.classify === undefined
                    ? undefined
                    : yield* tool.classify(decoded);

                return {
                  access: classified?.access,
                  resource:
                    classified?.resource ??
                    (tool.resource === undefined
                      ? repo || undefined
                      : tool.resource(decoded, repo)),
                  summary: `${tool.name}${repo ? ` ${repo}` : ""}\n${preview(input)}`,
                  run: tool.run(decoded, { cwd: directory, repo }).pipe(
                    Effect.map((output) =>
                      output === undefined ? { ok: true } : plain(output),
                    ),
                    Effect.provide(ghLayer),
                    Effect.mapError(toGhError),
                    Effect.timeoutOrElse({
                      duration: tool.timeout ?? "2 minutes",
                      orElse: () =>
                        Effect.fail(
                          new Tool.Error({
                            message: `${tool.name} timed out`,
                          }),
                        ),
                    }),
                  ),
                } satisfies PreparedCall;
              }).pipe(Effect.provide(ghLayer), Effect.mapError(toGhError)),
            ),
          ),
        ),
      ),
  };
};

const withGh = <A, E>(f: (gh: Gh["Service"]) => Effect.Effect<A, E>) =>
  Effect.flatMap(Effect.service(Gh), f);

/** The session directory's current branch, for tools whose head defaults to it. */
const currentBranch = (cwd: string) =>
  Effect.flatMap(
    Effect.service(ChildProcessSpawner.ChildProcessSpawner),
    (spawner) =>
      spawner.string(
        ChildProcess.make("git", ["branch", "--show-current"], { cwd }),
      ),
  ).pipe(
    Effect.map((branch) => branch.trim()),
    Effect.provide(NodeServices.layer),
  );

/** The REST path and host of [HOST/]OWNER/REPO. */
const restTarget = (repo: string) => {
  const parts = repo.split("/");

  return parts.length === 3
    ? { path: parts.slice(1).join("/"), hostname: parts[0] }
    : { path: repo };
};

/** A REST request under `repos/OWNER/REPO` of [HOST/]OWNER/REPO; `path` follows the repository, such as `/forks`. */
const repoRequest = (
  repo: string,
  path: string,
  request: Omit<Api.Request, "endpoint">,
): Api.Request => {
  const target = restTarget(repo);
  const endpoint = `repos/${target.path}${path}`;

  return target.hostname === undefined
    ? { ...request, endpoint }
    : { ...request, endpoint, hostname: target.hostname };
};

const RepositoryResponse = Schema.Struct({
  full_name: Schema.String,
  html_url: Schema.String,
  private: Schema.Boolean,
  default_branch: Schema.String,
});

const repositorySummary = (response: typeof RepositoryResponse.Type) => ({
  repo: response.full_name,
  url: response.html_url,
  private: response.private,
  defaultBranch: response.default_branch,
});

const flag = (name: string, value: string | undefined) =>
  value === undefined ? [] : [`--${name}=${value}`];

const flags = (name: string, values: readonly string[] | undefined) =>
  (values ?? []).map((value) => `--${name}=${value}`);

const repo = Schema.optionalKey(Schema.String).annotate({
  description:
    "OWNER/REPO, or HOST/OWNER/REPO. Defaults to the session directory's repository",
});

const number = (what: string) =>
  Schema.Int.annotate({ description: `The ${what} number` });

const selector = Schema.Union([Schema.Int, Schema.String]).annotate({
  description: "The pull request's number, URL or branch",
});

const body = (what: string) =>
  Schema.String.annotate({
    description: `The ${what} in GitHub Markdown. Reference attachments by their local path`,
  });

const headSha = Schema.String.annotate({
  description:
    "The head commit you reviewed (headRefOid from pr_view). The call fails if the branch has moved since",
});

const Attachments = Schema.optionalKey(
  Schema.Array(
    Schema.Struct({
      path: Schema.String.annotate({
        description:
          "The local file, written the same way the text references it",
      }),
      alt: Schema.String.annotate({
        description: "Alt text, used when the text doesn't reference the path",
      }),
    }),
  ),
).annotate({
  description:
    "Images, videos or other files to upload with this write. Each local path in the text is replaced with the file's URL, and a file the text doesn't reference is added at the end. Uploads go against the target repository when you can push to it, otherwise your fork of it, which must be public",
});

const uploadRepository = Schema.optionalKey(Schema.String).annotate({
  description:
    "A public OWNER/REPO to upload attachments against, instead of the target repository or your fork",
});

type AttachmentList = typeof Attachments.Type | undefined;

/** Where attachments for a post in `repo` go: the repository itself when you can push to it, otherwise your fork. */
const uploadTarget = Effect.fn("gh.uploadTarget")(function* (
  repo: string,
  cwd: string,
) {
  const target = yield* Api.json(
    { endpoint: `repos/${repo}`, method: "GET", options: { cwd } },
    Schema.Struct({
      name: Schema.String,
      private: Schema.Boolean,
      permissions: Schema.optionalKey(Schema.Struct({ push: Schema.Boolean })),
    }),
  );

  if (target.permissions?.push === true || target.private) return repo;

  const user = yield* Api.json(
    { endpoint: "user", method: "GET", options: { cwd } },
    Schema.Struct({ login: Schema.String }),
  );

  return `${user.login}/${target.name}`;
});

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const markdownLink = (path: string, alt: string, url: string) => {
  const type = Attachment.contentType(path);

  if (type.startsWith("image/")) return `![${alt}](${url})`;

  return type.startsWith("video/") ? url : `[${alt}](${url})`;
};

/**
 * Upload attachments and swap each local path in the texts for its URL. Files no text references
 * are added to the end of the first text.
 */
const attach = Effect.fn("gh.attach")(function* (
  texts: readonly string[],
  attachments: AttachmentList,
  call: GhCall,
  upload: string | undefined,
) {
  if (attachments === undefined || attachments.length === 0) return texts;

  const target =
    upload ??
    (yield* uploadTarget(
      call.repo || (yield* currentRepository(call.cwd)),
      call.cwd,
    ));

  const result = [...texts];

  for (const file of attachments) {
    const url = yield* Attachment.upload(
      { repository: target, path: file.path },
      { cwd: call.cwd },
    );

    const pattern = new RegExp(
      `(?:\\./)?${escapeRegExp(file.path.replace(/^\.\//, ""))}`,
      "g",
    );

    const referenced = result.some((text) =>
      new RegExp(pattern.source).test(text),
    );

    if (referenced) {
      for (const [index, text] of result.entries())
        result[index] = text.replace(pattern, url);
    } else {
      result[0] =
        `${result[0] ?? ""}\n\n${markdownLink(file.path, file.alt, url)}`.trimStart();
    }
  }

  return result;
});

const attachOne = (
  text: string,
  attachments: AttachmentList,
  call: GhCall,
  upload: string | undefined,
) =>
  attach([text], attachments, call, upload).pipe(
    Effect.map((texts) => texts[0] ?? text),
  );

const postComment = (repo: string, issue: number, text: string, cwd: string) =>
  Api.json(
    repoRequest(repo, `/issues/${issue}/comments`, {
      method: "POST",
      body: { body: text },
      options: { cwd },
    }),
    Schema.Struct({ id: Schema.Int, html_url: Schema.String }),
  ).pipe(Effect.map((comment) => ({ id: comment.id, url: comment.html_url })));

/** An API endpoint with owners, repositories, numbers and SHAs as placeholders, so "always allow" covers its shape. */
const endpointPattern = (endpoint: string) =>
  (
    endpoint
      .replace(/^https?:\/\/[^/]+\//, "")
      .replace(/^\//, "")
      .split(/[?#]/)[0] ?? ""
  )
    .replace(/^repos\/[^/]+\/[^/]+/, "repos/{owner}/{repo}")
    .replace(/\/[0-9a-f]{40}(?=\/|$)/g, "/{sha}")
    .replace(/\/\d+(?=\/|$)/g, "/{number}");

const prViewFields = [
  "number",
  "title",
  "url",
  "state",
  "isDraft",
  "author",
  "headRefName",
  "headRefOid",
  "baseRefName",
  "body",
  "reviewDecision",
  "mergeStateStatus",
  "labels",
  "assignees",
  "mergedAt",
  "autoMergeRequest",
] as const;

const prListFields = [
  "number",
  "title",
  "url",
  "state",
  "isDraft",
  "author",
  "headRefName",
  "labels",
] as const;

const issueViewFields = [
  "number",
  "title",
  "url",
  "state",
  "updatedAt",
  "author",
  "labels",
  "body",
  "issueType",
  "parent",
  "subIssuesSummary",
  "blockedBy",
  "blocking",
] as const;

const issueListFields = [
  "number",
  "title",
  "url",
  "state",
  "updatedAt",
  "author",
  "labels",
] as const;

const releaseFields = [
  "tagName",
  "name",
  "url",
  "body",
  "isDraft",
  "isPrerelease",
  "targetCommitish",
  "publishedAt",
  "assets",
] as const;

const issueReference = Schema.Union([Schema.Int, Schema.String]).annotate({
  description: "An issue's number or URL, which may be in another repository",
});

const issueReferences = (description: string) =>
  Schema.optionalKey(Schema.Array(issueReference)).annotate({ description });

const issueType = Schema.optionalKey(Schema.String).annotate({
  description:
    "The issue type by name, such as Bug, where the repository's organisation has issue types",
});

/** Every `--<name>=<value>` flag for a list of issue references. */
const issueFlags = (
  name: string,
  values: readonly (number | string)[] | undefined,
) => flags(name, values?.map(String));

const artifactNumber = Schema.Int.annotate({
  description: "The artifact's number on the issue, from issue_artifact_list",
});

/** An artifact without its rendered HTML, which repeats the body. */
const withoutHtml = <A extends { readonly bodyHtml: string }>(artifact: A) =>
  Struct.omit(artifact, ["bodyHtml"]);

/** Attachments as gh's `--attach` takes them, `<file>#<alt text>`. */
const ghAttachments = (attachments: AttachmentList) =>
  attachments?.map((file) => `${file.path}#${file.alt}`);

const artifactAttachments = Schema.optionalKey(
  Schema.Array(
    Schema.Struct({
      path: Schema.String.annotate({
        description: "The local image or video file",
      }),
      alt: Schema.String.annotate({ description: "Alt text" }),
    }),
  ),
).annotate({
  description:
    "Images or videos for a Markdown document. gh uploads them and swaps a reference to each path in the document for its URL, or adds it at the end",
});

const runStatus = Schema.Literals([
  "queued",
  "completed",
  "in_progress",
  "requested",
  "waiting",
  "pending",
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out",
]);

const secretApp = Schema.optionalKey(
  Schema.Literals(["actions", "dependabot"]),
).annotate({
  description: "Which secrets (default: actions)",
});

const projectOwner = Schema.optionalKey(Schema.String).annotate({
  description: "The project owner's login, or @me (the default) for your own",
});

const rulesetParents = Schema.optionalKey(Schema.Boolean).annotate({
  description: "Include rulesets configured at higher levels (default: true)",
});

const InlineComment = Schema.Struct({
  path: Schema.String.annotate({
    description: "The file's path in the repository",
  }),
  line: Schema.Int.annotate({
    description: "The last line of the range the comment applies to",
  }),
  body: body("comment"),
  side: Schema.optionalKey(Schema.Literals(["LEFT", "RIGHT"])).annotate({
    description:
      "RIGHT (the default) for the new side of the diff, LEFT for the old",
  }),
  startLine: Schema.optionalKey(Schema.Int).annotate({
    description: "The first line, for a comment on a range",
  }),
  startSide: Schema.optionalKey(Schema.Literals(["LEFT", "RIGHT"])),
});

const ReleaseSettings = {
  title: Schema.optionalKey(Schema.String),
  notes: Schema.optionalKey(Schema.String).annotate({
    description: "The release notes in GitHub Markdown",
  }),
  target: Schema.optionalKey(Schema.String).annotate({
    description: "The branch or full commit SHA to create the tag from",
  }),
  draft: Schema.optionalKey(Schema.Boolean),
  prerelease: Schema.optionalKey(Schema.Boolean),
};

/** The namespace's description in the Code Mode catalogue. */
export const description =
  "GitHub through the gh CLI: repositories (create, edit, fork, delete, read files), pull requests and their reviews, review threads and comments, issues, discussions, labels, releases, Actions runs, secrets, variables and caches, and search. Read-only tools cover projects, codespaces, gists, SSH, GPG and deploy keys, rulesets, autolinks, agent tasks, skills, gh's config and aliases, organisations, your status and gitignore and licence templates. `repo` defaults to the session directory's repository. Text writes take `attachments` ([{ path, alt }]), uploaded and swapped in for their local paths, including in reviews, inline review comments and discussions. Prefer the typed tools; `api` (REST) and `graphql` are the escape hatches, and run without asking for GET and HEAD requests and query-only documents. To wait for an Actions run outside a pull request, start `gh.run_watch` ({ repo, runId }) with jobs.start; use dot.pr_watch for pull requests.";

/** GitHub through the effect-gh SDK, run in the session directory. */
export const tools: readonly ClientTool[] = [
  ghTool({
    name: "repo_view",
    description:
      "View a repository: its name with owner, URL, default branch and whether it's private.",
    access: "read",
    repo: "local",
    input: Schema.Struct({ repo }),
    run: (_, call) =>
      Repository.view(call.repo || undefined, { cwd: call.cwd }),
  }),
  ghTool({
    name: "pr_view",
    description:
      "View a pull request, or the current branch's: title, body, state, author, head and base, head commit, review decision, merge state, labels and assignees.",
    access: "read",
    pinned: true,
    repo: "local",
    input: Schema.Struct({ repo, number: Schema.optionalKey(selector) }),
    run: (input, call) =>
      PullRequest.get(
        {
          repository: call.repo || undefined,
          selector: input.number,
          fields: prViewFields,
        },
        { cwd: call.cwd },
      ),
  }),
  ghTool({
    name: "pr_list",
    description: "List pull requests, 30 open ones by default, newest first.",
    access: "read",
    pinned: true,
    repo: "local",
    input: Schema.Struct({
      repo,
      state: Schema.optionalKey(
        Schema.Literals(["open", "closed", "merged", "all"]),
      ),
      limit: Schema.optionalKey(Schema.Int),
      base: Schema.optionalKey(Schema.String).annotate({
        description: "Only pull requests into this branch",
      }),
      head: Schema.optionalKey(Schema.String).annotate({
        description: "Only pull requests from this branch",
      }),
      search: Schema.optionalKey(Schema.String).annotate({
        description: "GitHub search qualifiers, such as author:@me",
      }),
    }),
    run: ({ ...input }, call) =>
      PullRequest.query(
        { ...input, repository: call.repo || undefined, fields: prListFields },
        { cwd: call.cwd },
      ),
  }),
  ghTool({
    name: "pr_checks",
    description:
      "A pull request's checks with their state and bucket (pass, fail, pending, skipping, cancel), and the overall status.",
    access: "read",
    input: Schema.Struct({
      repo,
      number: selector,
      required: Schema.optionalKey(Schema.Boolean).annotate({
        description: "Only required checks",
      }),
    }),
    run: (input, call) =>
      PullRequest.checks(input.number, {
        repository: call.repo,
        required: input.required,
        cwd: call.cwd,
      }),
  }),
  ghTool({
    name: "pr_diff",
    description: "A pull request's unified diff.",
    access: "read",
    input: Schema.Struct({ repo, number: selector }),
    run: (input, call) =>
      PullRequest.diff(input.number, { repository: call.repo, cwd: call.cwd }),
  }),
  ghTool({
    name: "pr_reviews",
    description:
      "Every review on a pull request with its author, state and body, oldest first.",
    access: "read",
    input: Schema.Struct({ repo, number: number("pull request") }),
    run: (input, call) =>
      Review.list({ repo: call.repo, number: input.number }, { cwd: call.cwd }),
  }),
  ghTool({
    name: "pr_review_threads",
    description:
      "Every review thread on a pull request with its ID, path, line, whether it's resolved or outdated, and its comments. Reply with review_thread_reply and resolve with review_thread_resolve by thread ID.",
    access: "read",
    pinned: true,
    input: Schema.Struct({
      repo,
      number: number("pull request"),
      unresolvedOnly: Schema.optionalKey(Schema.Boolean),
    }),
    run: (input, call) =>
      Review.threads({ ...input, repo: call.repo }, { cwd: call.cwd }),
  }),
  ghTool({
    name: "pr_comments",
    description:
      "Every conversation comment on a pull request, oldest first, with its numeric ID for comment_edit. Inline review comments are in pr_review_threads.",
    access: "read",
    input: Schema.Struct({ repo, number: number("pull request") }),
    run: (input, call) =>
      Comment.list(
        { repo: call.repo, number: input.number },
        { cwd: call.cwd },
      ),
  }),
  ghTool({
    name: "issue_view",
    description:
      "View an issue with its body, author, labels, issue type, parent, sub-issue progress, and the issues blocking it or blocked by it.",
    access: "read",
    repo: "local",
    input: Schema.Struct({
      repo,
      number: Schema.Union([Schema.Int, Schema.String]).annotate({
        description: "The issue's number or URL",
      }),
    }),
    run: (input, call) =>
      Issue.get(
        input.number,
        { repo: call.repo || undefined, fields: issueViewFields },
        { cwd: call.cwd },
      ),
  }),
  ghTool({
    name: "issue_list",
    description: "List issues, 30 open ones by default.",
    access: "read",
    repo: "local",
    input: Schema.Struct({
      repo,
      state: Schema.optionalKey(Schema.Literals(["open", "closed", "all"])),
      limit: Schema.optionalKey(Schema.Int),
      labels: Schema.optionalKey(Schema.Array(Schema.String)),
      assignee: Schema.optionalKey(Schema.String),
      search: Schema.optionalKey(Schema.String).annotate({
        description: "GitHub search qualifiers",
      }),
      type: issueType,
    }),
    run: ({ ...input }, call) =>
      Issue.query(
        { ...input, repo: call.repo || undefined, fields: issueListFields },
        { cwd: call.cwd },
      ),
  }),
  ghTool({
    name: "issue_comments",
    description:
      "Every comment on an issue, oldest first, with its numeric ID for comment_edit.",
    access: "read",
    input: Schema.Struct({ repo, number: number("issue") }),
    run: (input, call) =>
      Comment.list(
        { repo: call.repo, number: input.number },
        { cwd: call.cwd },
      ),
  }),
  ghTool({
    name: "issue_artifact_list",
    description:
      "List an issue's artifacts (Markdown and HTML documents and links attached to it, in preview) in number order, with their bodies. Only works on repositories enrolled in the issue artifacts preview.",
    access: "read",
    input: Schema.Struct({
      repo,
      number: number("issue"),
      type: Schema.optionalKey(
        Schema.Literals(["generic", "plan", "link", "embedded_html"]),
      ),
      limit: Schema.optionalKey(Schema.Int),
    }),
    run: ({ number: issue, ...options }, call) =>
      IssueArtifact.list(
        issue,
        { ...options, repo: call.repo },
        { cwd: call.cwd },
      ).pipe(Effect.map((artifacts) => artifacts.map(withoutHtml))),
  }),
  ghTool({
    name: "issue_artifact_view",
    description:
      "View an issue artifact with its edit history, newest version first.",
    access: "read",
    input: Schema.Struct({
      repo,
      number: number("issue"),
      artifact: artifactNumber,
    }),
    run: (input, call) =>
      IssueArtifact.view(
        input.number,
        input.artifact,
        { repo: call.repo },
        { cwd: call.cwd },
      ).pipe(
        Effect.map((artifact) => ({
          ...withoutHtml(artifact),
          versions: artifact.versions.map(withoutHtml),
        })),
      ),
  }),
  ghTool({
    name: "discussion_view",
    description:
      "View a discussion with its body, category and whether it's answered.",
    access: "read",
    input: Schema.Struct({ repo, number: number("discussion") }),
    run: (input, call) =>
      Discussion.view(
        { repo: call.repo, number: input.number },
        { cwd: call.cwd },
      ),
  }),
  ghTool({
    name: "discussion_list",
    description:
      "List discussions, 30 open ones by default, most recently updated first.",
    access: "read",
    input: Schema.Struct({
      repo,
      state: Schema.optionalKey(Schema.Literals(["open", "closed", "all"])),
      limit: Schema.optionalKey(Schema.Int),
    }),
    run: (input, call) =>
      Discussion.list({ ...input, repo: call.repo }, { cwd: call.cwd }),
  }),
  ghTool({
    name: "discussion_comments",
    description:
      "Every top-level comment on a discussion with its replies and node ID, which discussion_comment takes as replyTo.",
    access: "read",
    input: Schema.Struct({ repo, number: number("discussion") }),
    run: (input, call) =>
      Discussion.comments(
        { repo: call.repo, number: input.number },
        { cwd: call.cwd },
      ),
  }),
  ghTool({
    name: "release_view",
    description:
      "View a release, or the latest one, with its notes and assets.",
    access: "read",
    repo: "local",
    input: Schema.Struct({ repo, tag: Schema.optionalKey(Schema.String) }),
    run: (input, call) =>
      Release.view(
        { repo: call.repo || undefined, tag: input.tag, fields: releaseFields },
        { cwd: call.cwd },
      ),
  }),
  ghTool({
    name: "release_list",
    description: "List releases, newest first.",
    access: "read",
    repo: "local",
    input: Schema.Struct({ repo, limit: Schema.optionalKey(Schema.Int) }),
    run: (input, call) =>
      withGh((gh) =>
        gh.json(
          [
            "release",
            "list",
            "--json=tagName,name,isDraft,isPrerelease,isLatest,publishedAt",
            `--limit=${input.limit ?? 30}`,
            ...(call.repo ? [`--repo=${call.repo}`] : []),
          ],
          Schema.Unknown,
          { cwd: call.cwd },
        ),
      ),
  }),
  ghTool({
    name: "search_code",
    description:
      "Search code on GitHub with code search, by query, owner, repository or file name.",
    access: "read",
    repo: "none",
    input: Schema.Struct({
      query: Schema.String,
      owner: Schema.optionalKey(Schema.String),
      repo: Schema.optionalKey(Schema.String).annotate({
        description: "Only this OWNER/REPO",
      }),
      filename: Schema.optionalKey(Schema.String),
      limit: Schema.optionalKey(Schema.Int),
    }),
    run: (input, call) => Search.code(input, { cwd: call.cwd }),
  }),
  ghTool({
    name: "rate_limit",
    description:
      "The REST, GraphQL and search quotas left, with their reset times in epoch seconds.",
    access: "read",
    repo: "none",
    input: Schema.Struct({}),
    run: (_, call) =>
      Api.json(
        { endpoint: "rate_limit", method: "GET", options: { cwd: call.cwd } },
        Schema.Struct({
          resources: Schema.Record(Schema.String, Schema.Unknown),
        }),
      ).pipe(Effect.map((response) => response.resources)),
  }),
  ghTool({
    name: "repo_list",
    description:
      "List an owner's repositories, or yours, most recently pushed first.",
    access: "read",
    repo: "none",
    input: Schema.Struct({
      owner: Schema.optionalKey(Schema.String).annotate({
        description: "A user or organisation. Defaults to you",
      }),
      limit: Schema.optionalKey(Schema.Int),
      visibility: Schema.optionalKey(
        Schema.Literals(["public", "private", "internal"]),
      ),
      archived: Schema.optionalKey(Schema.Boolean).annotate({
        description:
          "Only archived repositories when true, only unarchived ones when false",
      }),
      fork: Schema.optionalKey(Schema.Boolean).annotate({
        description: "Only forks when true, only sources when false",
      }),
      language: Schema.optionalKey(Schema.String),
      topic: Schema.optionalKey(Schema.String),
    }),
    run: (input, call) =>
      withGh((gh) =>
        gh.json(
          [
            "repo",
            "list",
            ...(input.owner === undefined ? [] : [input.owner]),
            "--json=nameWithOwner,description,url,visibility,isArchived,isFork,defaultBranchRef,pushedAt",
            `--limit=${input.limit ?? 30}`,
            ...flag("visibility", input.visibility),
            ...(input.archived === undefined
              ? []
              : [input.archived ? "--archived" : "--no-archived"]),
            ...(input.fork === undefined
              ? []
              : [input.fork ? "--fork" : "--source"]),
            ...flag("language", input.language),
            ...flag("topic", input.topic),
          ],
          Schema.Unknown,
          { cwd: call.cwd },
        ),
      ),
  }),
  ghTool({
    name: "repo_read_file",
    description:
      "Read a file from a repository on GitHub, at its default branch or a ref, without cloning it.",
    access: "read",
    input: Schema.Struct({
      repo,
      path: Schema.String.annotate({
        description: "The file's path in the repository",
      }),
      ref: Schema.optionalKey(Schema.String).annotate({
        description: "A branch, tag or commit",
      }),
    }),
    run: (input, call) =>
      Api.text(
        repoRequest(
          call.repo,
          `/contents/${input.path.split("/").map(encodeURIComponent).join("/")}`,
          {
            method: "GET",
            headers: { Accept: "application/vnd.github.raw" },
            query: input.ref === undefined ? {} : { ref: input.ref },
            options: { cwd: call.cwd },
          },
        ),
      ),
  }),
  ghTool({
    name: "label_list",
    description:
      "List a repository's labels with their colour and description.",
    access: "read",
    input: Schema.Struct({
      repo,
      limit: Schema.optionalKey(Schema.Int),
      search: Schema.optionalKey(Schema.String).annotate({
        description:
          "Only labels whose name or description matches, best match first",
      }),
    }),
    run: (input, call) =>
      Label.list(
        { ...input, repo: call.repo, limit: input.limit ?? 100 },
        { cwd: call.cwd },
      ),
  }),
  ghTool({
    name: "workflow_list",
    description:
      "List a repository's Actions workflows with their ID, file path and state.",
    access: "read",
    input: Schema.Struct({
      repo,
      all: Schema.optionalKey(Schema.Boolean).annotate({
        description: "Include disabled workflows",
      }),
    }),
    run: (input, call) =>
      withGh((gh) =>
        gh.json(
          [
            "workflow",
            "list",
            `--repo=${call.repo}`,
            "--json=id,name,path,state",
            ...(input.all ? ["--all"] : []),
          ],
          Schema.Unknown,
          { cwd: call.cwd },
        ),
      ),
  }),
  ghTool({
    name: "run_download",
    description:
      "Download an Actions run's artifacts, all or those named, into a directory relative to the session directory.",
    access: "write",
    timeout: "10 minutes",
    input: Schema.Struct({
      repo,
      runId: Schema.Int,
      names: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
        description: "Artifact names (default: all)",
      }),
      directory: Schema.String,
    }),
    run: (input, call) =>
      withGh((gh) =>
        gh.execute(
          [
            "run",
            "download",
            `--repo=${call.repo}`,
            `--dir=${input.directory}`,
            ...(input.names ?? []).map((name) => `--name=${name}`),
            "--",
            String(input.runId),
          ],
          { cwd: call.cwd, timeout: "10 minutes" },
        ),
      ).pipe(Effect.asVoid),
  }),
  ghTool({
    name: "secret_list",
    description:
      "List a repository's Actions or Dependabot secret names and when they were updated. Values are never readable.",
    access: "read",
    input: Schema.Struct({ repo, app: secretApp }),
    run: (input, call) =>
      Secret.list(
        { repo: call.repo, app: input.app ?? "actions" },
        { cwd: call.cwd },
      ),
  }),
  ghTool({
    name: "secret_set",
    description:
      "Create or replace a repository's Actions or Dependabot secret.",
    access: "write",
    input: Schema.Struct({
      repo,
      app: secretApp,
      name: Schema.String,
      value: Schema.String,
    }),
    resource: (input, repo) => `${repo} ${input.name}`,
    run: (input, call) =>
      Secret.set(
        {
          repo: call.repo,
          app: input.app ?? "actions",
          name: input.name,
          value: input.value,
        },
        { cwd: call.cwd },
      ),
  }),
  ghTool({
    name: "secret_delete",
    description: "Delete a repository's Actions or Dependabot secret.",
    access: "write",
    input: Schema.Struct({ repo, app: secretApp, name: Schema.String }),
    resource: (input, repo) => `${repo} ${input.name}`,
    run: (input, call) =>
      Secret.remove(
        { repo: call.repo, app: input.app ?? "actions", name: input.name },
        { cwd: call.cwd },
      ),
  }),
  ghTool({
    name: "variable_list",
    description: "List a repository's Actions variables with their values.",
    access: "read",
    input: Schema.Struct({ repo }),
    run: (_input, call) =>
      Variable.list({ repo: call.repo }, { cwd: call.cwd }),
  }),
  ghTool({
    name: "variable_set",
    description: "Create or replace a repository's Actions variable.",
    access: "write",
    input: Schema.Struct({ repo, name: Schema.String, value: Schema.String }),
    resource: (input, repo) => `${repo} ${input.name}`,
    run: (input, call) =>
      Variable.set(
        { repo: call.repo, name: input.name, value: input.value },
        { cwd: call.cwd },
      ),
  }),
  ghTool({
    name: "variable_delete",
    description: "Delete a repository's Actions variable.",
    access: "write",
    input: Schema.Struct({ repo, name: Schema.String }),
    resource: (input, repo) => `${repo} ${input.name}`,
    run: (input, call) =>
      Variable.remove({ repo: call.repo, name: input.name }, { cwd: call.cwd }),
  }),
  ghTool({
    name: "cache_list",
    description:
      "List a repository's Actions caches, newest first, optionally for one key prefix or ref.",
    access: "read",
    input: Schema.Struct({
      repo,
      key: Schema.optionalKey(Schema.String).annotate({
        description: "Only caches whose key starts with this",
      }),
      ref: Schema.optionalKey(Schema.String).annotate({
        description: "Only caches for this ref, such as refs/heads/main",
      }),
      limit: Schema.optionalKey(Schema.Int),
    }),
    run: (input, call) =>
      Cache.list({ ...input, repo: call.repo }, { cwd: call.cwd }),
  }),
  ghTool({
    name: "cache_delete",
    description:
      "Delete an Actions cache by its ID or key, or every cache with all.",
    access: "write",
    input: Schema.Struct({
      repo,
      cache: Schema.optionalKey(Schema.String).annotate({
        description: "The cache's ID or key, from cache_list",
      }),
      all: Schema.optionalKey(Schema.Boolean),
    }),
    resource: (input, repo) =>
      `${repo} ${input.all ? "--all" : (input.cache ?? "")}`,
    run: (input, call) =>
      input.all === true
        ? Cache.remove({ repo: call.repo, all: true }, { cwd: call.cwd })
        : input.cache === undefined
          ? Effect.fail(
              new GhInvalidOptionsError({
                cause: new Error("Pass cache or all"),
              }),
            )
          : Cache.remove(
              /^\d+$/.test(input.cache)
                ? { repo: call.repo, id: Number(input.cache) }
                : { repo: call.repo, key: input.cache },
              { cwd: call.cwd },
            ),
  }),
  ghTool({
    name: "auth_status",
    description:
      "The accounts gh is signed in to, per host: login, token source, scopes and git protocol.",
    access: "read",
    repo: "none",
    input: Schema.Struct({}),
    run: (_input, call) =>
      withGh((gh) =>
        gh.json(["auth", "status", "--json=hosts"], Schema.Unknown, {
          cwd: call.cwd,
        }),
      ),
  }),
  ghTool({
    name: "search_issues",
    description:
      "Search issues or pull requests across GitHub with GitHub search syntax, such as is:open author:@me, optionally in one owner or repository.",
    access: "read",
    repo: "none",
    input: Schema.Struct({
      query: Schema.String,
      type: Schema.optionalKey(Schema.Literals(["issues", "prs"])).annotate({
        description: "issues by default",
      }),
      owner: Schema.optionalKey(Schema.String),
      repo: Schema.optionalKey(Schema.String).annotate({
        description: "Only this OWNER/REPO",
      }),
      state: Schema.optionalKey(Schema.Literals(["open", "closed"])),
      limit: Schema.optionalKey(Schema.Int),
    }),
    run: (input, call) =>
      withGh((gh) =>
        gh.json(
          [
            "search",
            input.type ?? "issues",
            "--json=number,title,url,state,repository,author,labels,updatedAt",
            `--limit=${input.limit ?? 30}`,
            ...flag("owner", input.owner),
            ...flag("repo", input.repo),
            ...flag("state", input.state),
            "--",
            input.query,
          ],
          Schema.Unknown,
          { cwd: call.cwd },
        ),
      ),
  }),
  ghTool({
    name: "search_repos",
    description:
      "Search repositories across GitHub with GitHub search syntax, optionally in one owner.",
    access: "read",
    repo: "none",
    input: Schema.Struct({
      query: Schema.String,
      owner: Schema.optionalKey(Schema.String),
      limit: Schema.optionalKey(Schema.Int),
    }),
    run: (input, call) =>
      withGh((gh) =>
        gh.json(
          [
            "search",
            "repos",
            "--json=fullName,description,url,visibility,isArchived,stargazersCount,updatedAt",
            `--limit=${input.limit ?? 30}`,
            ...flag("owner", input.owner),
            "--",
            input.query,
          ],
          Schema.Unknown,
          { cwd: call.cwd },
        ),
      ),
  }),
  ghTool({
    name: "run_list",
    description: "List recent Actions runs, 20 by default, newest first.",
    access: "read",
    pinned: true,
    input: Schema.Struct({
      repo,
      limit: Schema.optionalKey(Schema.Int),
      branch: Schema.optionalKey(Schema.String),
      commit: Schema.optionalKey(Schema.String),
      workflow: Schema.optionalKey(Schema.String).annotate({
        description: "The workflow's name, file name or ID",
      }),
      status: Schema.optionalKey(runStatus),
    }),
    run: (input, call) =>
      Workflow.list({ ...input, repo: call.repo }, { cwd: call.cwd }),
  }),
  ghTool({
    name: "run_view",
    description:
      "View an Actions run's status and conclusion, the latest attempt unless attempt is set.",
    access: "read",
    input: Schema.Struct({
      repo,
      runId: Schema.Int,
      attempt: Schema.optionalKey(Schema.Int),
    }),
    run: (input, call) =>
      Workflow.view({ ...input, repo: call.repo }, { cwd: call.cwd }),
  }),
  ghTool({
    name: "run_jobs",
    description:
      "An Actions run's jobs and their steps, with their IDs for run_logs and run_rerun.",
    access: "read",
    input: Schema.Struct({
      repo,
      runId: Schema.Int,
      attempt: Schema.optionalKey(Schema.Int),
    }),
    run: (input, call) =>
      Workflow.jobs({ ...input, repo: call.repo }, { cwd: call.cwd }),
  }),
  ghTool({
    name: "run_logs",
    description:
      "An Actions run's logs, or only its failed steps' with failedOnly, optionally for one job.",
    access: "read",
    input: Schema.Struct({
      repo,
      runId: Schema.Int,
      attempt: Schema.optionalKey(Schema.Int),
      failedOnly: Schema.optionalKey(Schema.Boolean),
      job: Schema.optionalKey(Schema.Int).annotate({
        description: "The job's ID from run_jobs",
      }),
    }),
    run: (input, call) =>
      Workflow.logs({ ...input, repo: call.repo }, { cwd: call.cwd }),
  }),
  ghTool({
    name: "pr_create",
    description:
      "Open a pull request and return its URL. The head defaults to the session directory's current branch, and the base to the repository's default branch; pass head as OWNER:BRANCH for a fork.",
    access: "write",
    input: Schema.Struct({
      repo,
      title: Schema.String,
      body: body("description"),
      base: Schema.optionalKey(Schema.String),
      head: Schema.optionalKey(Schema.String),
      draft: Schema.optionalKey(Schema.Boolean),
      assignees: Schema.optionalKey(Schema.Array(Schema.String)),
      labels: Schema.optionalKey(Schema.Array(Schema.String)),
      attachments: Attachments,
      uploadRepository,
    }),
    run: (input, call) =>
      Effect.gen(function* () {
        const head = input.head ?? (yield* currentBranch(call.cwd));

        const base =
          input.base ??
          (yield* Repository.view(call.repo, { cwd: call.cwd }))
            .defaultBranchRef?.name ??
          "main";

        const text = yield* attachOne(
          input.body,
          input.attachments,
          call,
          input.uploadRepository,
        );

        const created = yield* PullRequest.create(
          {
            repository: call.repo,
            base,
            head,
            title: input.title,
            body: text,
            assignees: input.assignees,
            draft: input.draft,
          },
          { cwd: call.cwd },
        );

        if (input.labels !== undefined && input.labels.length > 0)
          yield* PullRequest.edit(
            created.url,
            { repository: call.repo, addLabels: input.labels },
            { cwd: call.cwd },
          );

        return {
          number: Number(created.url.split("/").at(-1)),
          url: created.url,
        };
      }),
  }),
  ghTool({
    name: "pr_edit",
    description:
      "Change a pull request's title, body, base, labels, assignees or requested reviewers.",
    access: "write",
    input: Schema.Struct({
      repo,
      number: selector,
      title: Schema.optionalKey(Schema.String),
      body: Schema.optionalKey(body("description")),
      base: Schema.optionalKey(Schema.String).annotate({
        description: "The branch to merge into",
      }),
      addLabels: Schema.optionalKey(Schema.Array(Schema.String)),
      removeLabels: Schema.optionalKey(Schema.Array(Schema.String)),
      addAssignees: Schema.optionalKey(Schema.Array(Schema.String)),
      removeAssignees: Schema.optionalKey(Schema.Array(Schema.String)),
      addReviewers: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
        description: "Users, or OWNER/TEAM for teams, to request a review from",
      }),
      removeReviewers: Schema.optionalKey(Schema.Array(Schema.String)),
      attachments: Attachments,
      uploadRepository,
    }),
    run: (
      { number: pr, attachments, uploadRepository: upload, ...input },
      call,
    ) =>
      Effect.gen(function* () {
        const text =
          input.body === undefined
            ? undefined
            : yield* attachOne(input.body, attachments, call, upload);

        const changes = [
          ...flag("title", input.title),
          ...flag("body", text),
          ...flag("base", input.base),
          ...flags("add-label", input.addLabels),
          ...flags("remove-label", input.removeLabels),
          ...flags("add-assignee", input.addAssignees),
          ...flags("remove-assignee", input.removeAssignees),
          ...flags("add-reviewer", input.addReviewers),
          ...flags("remove-reviewer", input.removeReviewers),
        ];

        if (changes.length === 0)
          return yield* new Tool.Error({ message: "Nothing to change" });

        yield* withGh((gh) =>
          gh.execute(
            ["pr", "edit", `--repo=${call.repo}`, ...changes, "--", String(pr)],
            { cwd: call.cwd },
          ),
        );
      }),
  }),
  ghTool({
    name: "pr_ready",
    description:
      "Mark a draft pull request ready for review, or turn it back into a draft with draft.",
    access: "write",
    input: Schema.Struct({
      repo,
      number: selector,
      draft: Schema.optionalKey(Schema.Boolean).annotate({
        description: "Convert to a draft instead",
      }),
    }),
    resource: (input, repo) => `${repo}${input.draft ? " draft" : ""}`,
    run: (input, call) =>
      withGh((gh) =>
        gh.execute(
          [
            "pr",
            "ready",
            `--repo=${call.repo}`,
            ...(input.draft ? ["--undo"] : []),
            "--",
            String(input.number),
          ],
          { cwd: call.cwd },
        ),
      ).pipe(Effect.asVoid),
  }),
  ghTool({
    name: "pr_close",
    description:
      "Close a pull request without merging, optionally with a comment and deleting its branch.",
    access: "write",
    input: Schema.Struct({
      repo,
      number: selector,
      comment: Schema.optionalKey(Schema.String),
      deleteBranch: Schema.optionalKey(Schema.Boolean),
    }),
    run: (input, call) =>
      withGh((gh) =>
        gh.execute(
          [
            "pr",
            "close",
            `--repo=${call.repo}`,
            ...flag("comment", input.comment),
            ...(input.deleteBranch ? ["--delete-branch"] : []),
            "--",
            String(input.number),
          ],
          { cwd: call.cwd },
        ),
      ).pipe(Effect.asVoid),
  }),
  ghTool({
    name: "pr_reopen",
    description: "Reopen a closed pull request, optionally with a comment.",
    access: "write",
    input: Schema.Struct({
      repo,
      number: selector,
      comment: Schema.optionalKey(Schema.String),
    }),
    run: (input, call) =>
      withGh((gh) =>
        gh.execute(
          [
            "pr",
            "reopen",
            `--repo=${call.repo}`,
            ...flag("comment", input.comment),
            "--",
            String(input.number),
          ],
          { cwd: call.cwd },
        ),
      ).pipe(Effect.asVoid),
  }),
  ghTool({
    name: "pr_checkout",
    description:
      "Check out a pull request's branch in a local checkout of its repository, fetching it from a fork when needed. directory is required, so it never switches the session directory's checkout by accident.",
    access: "write",
    repo: "none",
    input: Schema.Struct({
      directory: Schema.String.check(Schema.isStartingWith("/")).annotate({
        description:
          "The absolute path of a local checkout of the pull request's repository",
      }),
      number: selector,
      branch: Schema.optionalKey(Schema.String).annotate({
        description: "The local branch name to use",
      }),
    }),
    resource: (input) => `${input.directory} ${input.number}`,
    run: (input) =>
      PullRequest.checkout(
        input.number,
        input.branch === undefined ? {} : { branch: input.branch },
        {
          cwd: input.directory,
        },
      ),
  }),
  ghTool({
    name: "pr_comment",
    description:
      "Comment on a pull request's conversation and return the comment's ID and URL.",
    access: "write",
    input: Schema.Struct({
      repo,
      number: number("pull request"),
      body: body("comment"),
      attachments: Attachments,
      uploadRepository,
    }),
    run: (input, call) =>
      attachOne(
        input.body,
        input.attachments,
        call,
        input.uploadRepository,
      ).pipe(
        Effect.flatMap((text) =>
          postComment(call.repo, input.number, text, call.cwd),
        ),
      ),
  }),
  ghTool({
    name: "pr_review",
    description:
      "Submit a review on the head commit you read: approve, request changes or comment, with optional inline comments. Fails if the branch has moved.",
    access: "write",
    input: Schema.Struct({
      repo,
      number: number("pull request"),
      event: Schema.Literals(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
      headSha,
      body: Schema.optionalKey(body("review")).annotate({
        description:
          "The review body in GitHub Markdown. Required to request changes or comment",
      }),
      comments: Schema.optionalKey(Schema.Array(InlineComment)),
      attachments: Attachments,
      uploadRepository,
    }),
    run: (input, call) =>
      Effect.gen(function* () {
        const current = yield* PullRequest.get(
          {
            repository: call.repo,
            selector: input.number,
            fields: ["headRefOid"],
          },
          { cwd: call.cwd },
        );

        if (current.headRefOid !== input.headSha)
          return yield* new Tool.Error({
            message: `The head moved from ${input.headSha} to ${current.headRefOid}; review the new commits first.`,
          });

        const comments = input.comments ?? [];

        const [text = "", ...bodies] = yield* attach(
          [input.body ?? "", ...comments.map((comment) => comment.body)],
          input.attachments,
          call,
          input.uploadRepository,
        );

        const review = {
          repo: call.repo,
          number: input.number,
          event: input.event,
          commitId: input.headSha,
        } satisfies Review.SubmitOptions;

        const withBody = text === "" ? review : { ...review, body: text };

        return yield* Review.submit(
          comments.length === 0
            ? withBody
            : {
                ...withBody,
                comments: comments.map((comment, index) => ({
                  ...comment,
                  body: bodies[index] ?? comment.body,
                })),
              },
          { cwd: call.cwd },
        );
      }),
  }),
  ghTool({
    name: "pr_merge",
    description:
      "Merge a pull request pinned to the head commit you reviewed, or turn on auto-merge with auto, then return its state.",
    access: "write",
    input: Schema.Struct({
      repo,
      number: number("pull request"),
      method: Schema.Literals(["squash", "merge", "rebase"]),
      headSha,
      auto: Schema.optionalKey(Schema.Boolean).annotate({
        description: "Merge once its requirements are met instead of now",
      }),
    }),
    resource: (input, repo) => `${repo} ${input.method}`,
    run: (input, call) =>
      Effect.gen(function* () {
        yield* withGh((gh) =>
          gh.execute(
            [
              "pr",
              "merge",
              `--repo=${call.repo}`,
              `--${input.method}`,
              `--match-head-commit=${input.headSha}`,
              ...(input.auto ? ["--auto"] : []),
              "--",
              String(input.number),
            ],
            { cwd: call.cwd },
          ),
        );

        return yield* PullRequest.get(
          {
            repository: call.repo,
            selector: input.number,
            fields: ["state", "mergedAt", "autoMergeRequest", "url"],
          },
          { cwd: call.cwd },
        );
      }),
  }),
  ghTool({
    name: "review_thread_reply",
    description: "Reply to a review thread by its ID from pr_review_threads.",
    access: "write",
    repo: "local",
    input: Schema.Struct({
      repo: Schema.optionalKey(Schema.String).annotate({
        description:
          "The pull request's OWNER/REPO, for uploading attachments. Defaults to the session directory's",
      }),
      threadId: Schema.String,
      body: body("reply"),
      attachments: Attachments,
      uploadRepository,
    }),
    run: (input, call) =>
      attachOne(
        input.body,
        input.attachments,
        call,
        input.uploadRepository,
      ).pipe(
        Effect.flatMap((text) =>
          Review.reply(
            { threadId: input.threadId, body: text },
            { cwd: call.cwd },
          ),
        ),
      ),
  }),
  ghTool({
    name: "review_thread_resolve",
    description: "Resolve a review thread by its ID from pr_review_threads.",
    access: "write",
    repo: "none",
    input: Schema.Struct({ threadId: Schema.String }),
    run: (input, call) =>
      Review.resolve({ threadId: input.threadId }, { cwd: call.cwd }),
  }),
  ghTool({
    name: "review_thread_unresolve",
    description: "Unresolve a review thread by its ID from pr_review_threads.",
    access: "write",
    repo: "none",
    input: Schema.Struct({ threadId: Schema.String }),
    run: (input, call) =>
      Review.unresolve({ threadId: input.threadId }, { cwd: call.cwd }),
  }),
  ghTool({
    name: "comment_edit",
    description:
      "Replace the body of your pull request or issue comment, or with kind review your inline review comment, by its numeric ID.",
    access: "write",
    input: Schema.Struct({
      repo,
      id: Schema.Int.annotate({ description: "The comment's numeric ID" }),
      kind: Schema.optionalKey(Schema.Literals(["issue", "review"])),
      body: body("comment"),
      attachments: Attachments,
      uploadRepository,
    }),
    run: ({ attachments, uploadRepository: upload, ...input }, call) =>
      attachOne(input.body, attachments, call, upload).pipe(
        Effect.flatMap((text) =>
          Comment.edit(
            { ...input, body: text, repo: call.repo },
            { cwd: call.cwd },
          ),
        ),
      ),
  }),
  ghTool({
    name: "comment_delete",
    description:
      "Delete your pull request or issue comment, or with kind review your inline review comment, by its numeric ID.",
    access: "write",
    input: Schema.Struct({
      repo,
      id: Schema.Int,
      kind: Schema.optionalKey(Schema.Literals(["issue", "review"])),
    }),
    run: (input, call) =>
      Comment.remove({ ...input, repo: call.repo }, { cwd: call.cwd }),
  }),
  ghTool({
    name: "issue_create",
    description: "Open an issue and return its URL.",
    access: "write",
    input: Schema.Struct({
      repo,
      title: Schema.String,
      body: body("issue"),
      labels: Schema.optionalKey(Schema.Array(Schema.String)),
      type: issueType,
      parent: Schema.optionalKey(issueReference).annotate({
        description: "Make the new issue a sub-issue of this one",
      }),
      blockedBy: issueReferences("Issues blocking the new one"),
      blocking: issueReferences("Issues the new one blocks"),
      attachments: Attachments,
      uploadRepository,
    }),
    run: (
      { body: issueBody, attachments, uploadRepository: upload, ...input },
      call,
    ) =>
      attachOne(issueBody, attachments, call, upload).pipe(
        Effect.flatMap((text) =>
          Issue.create(
            { ...input, repo: call.repo, body: text },
            { cwd: call.cwd },
          ),
        ),
        Effect.map((created) => ({
          number: Number(created.url.split("/").at(-1)),
          url: created.url,
        })),
      ),
  }),
  ghTool({
    name: "issue_edit",
    description:
      "Change an issue's title, body, labels, assignees, milestone, issue type, parent, sub-issues or blocking relationships.",
    access: "write",
    input: Schema.Struct({
      repo,
      number: number("issue"),
      title: Schema.optionalKey(Schema.String),
      body: Schema.optionalKey(body("issue")),
      addLabels: Schema.optionalKey(Schema.Array(Schema.String)),
      removeLabels: Schema.optionalKey(Schema.Array(Schema.String)),
      addAssignees: Schema.optionalKey(Schema.Array(Schema.String)),
      removeAssignees: Schema.optionalKey(Schema.Array(Schema.String)),
      milestone: Schema.optionalKey(Schema.String).annotate({
        description: "The milestone's title",
      }),
      type: issueType,
      removeType: Schema.optionalKey(Schema.Boolean),
      parent: Schema.optionalKey(issueReference).annotate({
        description: "Make the issue a sub-issue of this one",
      }),
      removeParent: Schema.optionalKey(Schema.Boolean),
      addSubIssues: issueReferences("Issues to make sub-issues of this one"),
      removeSubIssues: issueReferences("Sub-issues to detach"),
      addBlockedBy: issueReferences("Issues to mark as blocking this one"),
      removeBlockedBy: issueReferences(
        "Issues to no longer mark as blocking this one",
      ),
      addBlocking: issueReferences("Issues to mark as blocked by this one"),
      removeBlocking: issueReferences(
        "Issues to no longer mark as blocked by this one",
      ),
      attachments: Attachments,
      uploadRepository,
    }),
    run: (
      { number: issue, attachments, uploadRepository: upload, ...input },
      call,
    ) =>
      Effect.gen(function* () {
        const text =
          input.body === undefined
            ? undefined
            : yield* attachOne(input.body, attachments, call, upload);

        const changes = [
          ...flag("title", input.title),
          ...flag("body", text),
          ...flags("add-label", input.addLabels),
          ...flags("remove-label", input.removeLabels),
          ...flags("add-assignee", input.addAssignees),
          ...flags("remove-assignee", input.removeAssignees),
          ...flag("milestone", input.milestone),
          ...flag("type", input.type),
          ...(input.removeType ? ["--remove-type"] : []),
          ...flag(
            "parent",
            input.parent === undefined ? undefined : String(input.parent),
          ),
          ...(input.removeParent ? ["--remove-parent"] : []),
          ...issueFlags("add-sub-issue", input.addSubIssues),
          ...issueFlags("remove-sub-issue", input.removeSubIssues),
          ...issueFlags("add-blocked-by", input.addBlockedBy),
          ...issueFlags("remove-blocked-by", input.removeBlockedBy),
          ...issueFlags("add-blocking", input.addBlocking),
          ...issueFlags("remove-blocking", input.removeBlocking),
        ];

        if (changes.length === 0)
          return yield* new Tool.Error({ message: "Nothing to change" });

        yield* withGh((gh) =>
          gh.execute(
            [
              "issue",
              "edit",
              `--repo=${call.repo}`,
              ...changes,
              "--",
              String(issue),
            ],
            { cwd: call.cwd },
          ),
        );
      }),
  }),
  ghTool({
    name: "issue_comment",
    description: "Comment on an issue and return the comment's ID and URL.",
    access: "write",
    input: Schema.Struct({
      repo,
      number: number("issue"),
      body: body("comment"),
      attachments: Attachments,
      uploadRepository,
    }),
    run: (input, call) =>
      attachOne(
        input.body,
        input.attachments,
        call,
        input.uploadRepository,
      ).pipe(
        Effect.flatMap((text) =>
          postComment(call.repo, input.number, text, call.cwd),
        ),
      ),
  }),
  ghTool({
    name: "issue_artifact_create",
    description:
      "Attach artifacts to an issue (in preview): one per local file or URL in sources, or a single document from body. A .md or text file becomes a document, .html an HTML document, and a URL a link. Returns each artifact's status and number.",
    access: "write",
    input: Schema.Struct({
      repo,
      number: number("issue"),
      sources: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
        description:
          "Local files (add #<name> to name one) and URLs, one artifact each. Leave out with body",
      }),
      body: Schema.optionalKey(Schema.String).annotate({
        description: "Markdown for a single document; needs name",
      }),
      name: Schema.optionalKey(Schema.String).annotate({
        description: "The name for a single artifact",
      }),
      type: Schema.optionalKey(
        Schema.Literals(["generic", "plan", "embedded_html"]),
      ),
      attachments: artifactAttachments,
    }),
    run: ({ number: issue, attachments, ...input }, call) =>
      IssueArtifact.create(
        issue,
        { ...input, repo: call.repo, attachments: ghAttachments(attachments) },
        { cwd: call.cwd },
      ),
  }),
  ghTool({
    name: "issue_artifact_edit",
    description:
      "Rename an issue artifact, replace its content (a link's URL for a link), or restore an earlier version from issue_artifact_view as a new one.",
    access: "write",
    input: Schema.Struct({
      repo,
      number: number("issue"),
      artifact: artifactNumber,
      name: Schema.optionalKey(Schema.String),
      body: Schema.optionalKey(Schema.String),
      restoreVersion: Schema.optionalKey(Schema.Int).annotate({
        description:
          "An earlier version's number; can't be combined with the other changes",
      }),
      attachments: artifactAttachments,
    }),
    run: ({ number: issue, artifact, attachments, ...input }, call) =>
      IssueArtifact.edit(
        issue,
        artifact,
        { ...input, repo: call.repo, attachments: ghAttachments(attachments) },
        { cwd: call.cwd },
      ),
  }),
  ghTool({
    name: "issue_artifact_delete",
    description: "Delete artifacts from an issue. They can't be restored.",
    access: "write",
    input: Schema.Struct({
      repo,
      number: number("issue"),
      artifacts: Schema.Array(artifactNumber),
    }),
    run: (input, call) =>
      IssueArtifact.remove(
        input.number,
        input.artifacts,
        { repo: call.repo },
        { cwd: call.cwd },
      ),
  }),
  ghTool({
    name: "issue_close",
    description:
      "Close an issue as completed or not planned, optionally with a closing comment.",
    access: "write",
    input: Schema.Struct({
      repo,
      number: number("issue"),
      reason: Schema.optionalKey(Schema.Literals(["completed", "not planned"])),
      comment: Schema.optionalKey(Schema.String),
    }),
    run: (input, call) =>
      withGh((gh) =>
        gh.execute(
          [
            "issue",
            "close",
            `--repo=${call.repo}`,
            ...(input.reason === undefined ? [] : [`--reason=${input.reason}`]),
            ...(input.comment === undefined
              ? []
              : [`--comment=${input.comment}`]),
            "--",
            String(input.number),
          ],
          { cwd: call.cwd },
        ),
      ).pipe(Effect.asVoid),
  }),
  ghTool({
    name: "issue_reopen",
    description: "Reopen a closed issue, optionally with a comment.",
    access: "write",
    input: Schema.Struct({
      repo,
      number: number("issue"),
      comment: Schema.optionalKey(Schema.String),
    }),
    run: (input, call) =>
      withGh((gh) =>
        gh.execute(
          [
            "issue",
            "reopen",
            `--repo=${call.repo}`,
            ...flag("comment", input.comment),
            "--",
            String(input.number),
          ],
          { cwd: call.cwd },
        ),
      ).pipe(Effect.asVoid),
  }),
  ghTool({
    name: "discussion_comment",
    description:
      "Comment on a discussion, or reply to one of its comments with replyTo, and return the comment's ID and URL.",
    access: "write",
    input: Schema.Struct({
      repo,
      number: number("discussion"),
      body: body("comment"),
      replyTo: Schema.optionalKey(Schema.String).annotate({
        description:
          "The node ID of the top-level comment to reply to, from discussion_comments",
      }),
      attachments: Attachments,
      uploadRepository,
    }),
    run: (input, call) =>
      attachOne(
        input.body,
        input.attachments,
        call,
        input.uploadRepository,
      ).pipe(
        Effect.flatMap((text) =>
          input.replyTo === undefined
            ? Discussion.comment(
                { repo: call.repo, number: input.number, body: text },
                { cwd: call.cwd },
              )
            : Discussion.reply(
                { commentId: input.replyTo, body: text },
                { cwd: call.cwd },
              ),
        ),
      ),
  }),
  ghTool({
    name: "release_create",
    description:
      "Create a release and return its URL. Asset paths are relative to the session directory.",
    access: "write",
    input: Schema.Struct({
      repo,
      tag: Schema.String,
      ...ReleaseSettings,
      generateNotes: Schema.optionalKey(Schema.Boolean).annotate({
        description: "Generate notes from merged pull requests",
      }),
      notesStartTag: Schema.optionalKey(Schema.String),
      verifyTag: Schema.optionalKey(Schema.Boolean).annotate({
        description: "Fail unless the tag already exists on the remote",
      }),
      assets: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
    run: (input, call) =>
      Release.create({ ...input, repo: call.repo }, { cwd: call.cwd }),
  }),
  ghTool({
    name: "release_edit",
    description:
      "Change a release's title, notes, target, or draft and prerelease state.",
    access: "write",
    input: Schema.Struct({ repo, tag: Schema.String, ...ReleaseSettings }),
    run: (input, call) =>
      Release.edit({ ...input, repo: call.repo }, { cwd: call.cwd }),
  }),
  ghTool({
    name: "release_upload",
    description:
      "Upload asset files to a release, replacing ones with the same name with clobber. Paths are relative to the session directory.",
    access: "write",
    timeout: "10 minutes",
    input: Schema.Struct({
      repo,
      tag: Schema.String,
      assets: Schema.Array(Schema.String),
      clobber: Schema.optionalKey(Schema.Boolean),
    }),
    run: (input, call) =>
      Release.upload({ ...input, repo: call.repo }, { cwd: call.cwd }),
  }),
  ghTool({
    name: "run_rerun",
    description:
      "Rerun an Actions run, only its failed jobs with failedOnly, or one job.",
    access: "write",
    input: Schema.Struct({
      repo,
      runId: Schema.Int,
      failedOnly: Schema.optionalKey(Schema.Boolean),
      job: Schema.optionalKey(Schema.Int).annotate({
        description: "The job's ID from run_jobs",
      }),
    }),
    run: (input, call) =>
      Workflow.rerun({ ...input, repo: call.repo }, { cwd: call.cwd }),
  }),
  ghTool({
    name: "workflow_dispatch",
    description:
      "Start a workflow_dispatch run of a workflow, by file name or ID.",
    access: "write",
    input: Schema.Struct({
      repo,
      workflow: Schema.String,
      ref: Schema.optionalKey(Schema.String),
      inputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    }),
    resource: (input, repo) => `${repo} ${input.workflow}`,
    run: (input, call) =>
      Workflow.dispatch({ ...input, repo: call.repo }, { cwd: call.cwd }),
  }),
  ghTool({
    name: "label_create",
    description: "Create a label, or update it with force.",
    access: "write",
    input: Schema.Struct({
      repo,
      name: Schema.String,
      color: Schema.optionalKey(Schema.String).annotate({
        description: "A hex colour without #",
      }),
      description: Schema.optionalKey(Schema.String),
      force: Schema.optionalKey(Schema.Boolean),
    }),
    run: (input, call) =>
      Label.create({ ...input, repo: call.repo }, { cwd: call.cwd }),
  }),
  ghTool({
    name: "label_delete",
    description:
      "Delete a label from a repository, removing it from every issue and pull request.",
    access: "write",
    input: Schema.Struct({ repo, name: Schema.String }),
    resource: (input, repo) => `${repo} ${input.name}`,
    run: (input, call) =>
      Label.remove({ ...input, repo: call.repo }, { cwd: call.cwd }),
  }),
  ghTool({
    name: "label_edit",
    description:
      "Rename a label or change its colour or description, keeping it on its issues and pull requests.",
    access: "write",
    input: Schema.Struct({
      repo,
      name: Schema.String.annotate({ description: "The label's current name" }),
      newName: Schema.optionalKey(Schema.String),
      color: Schema.optionalKey(Schema.String).annotate({
        description: "A hex colour without #",
      }),
      description: Schema.optionalKey(Schema.String),
    }),
    resource: (input, repo) => `${repo} ${input.name}`,
    run: (input, call) =>
      Label.edit({ ...input, repo: call.repo }, { cwd: call.cwd }),
  }),
  ghTool({
    name: "label_clone",
    description:
      "Copy every label from a source repository. Existing labels are skipped, or overwritten with force; labels only in the target are left alone.",
    access: "write",
    input: Schema.Struct({
      repo,
      source: Schema.String.annotate({
        description: "The repository to copy labels from, as OWNER/REPO",
      }),
      force: Schema.optionalKey(Schema.Boolean),
    }),
    resource: (input, repo) => `${repo} from ${input.source}`,
    run: (input, call) =>
      Label.clone({ ...input, repo: call.repo }, { cwd: call.cwd }),
  }),
  ghTool({
    name: "release_delete",
    description: "Delete a release, and its tag too with cleanupTag.",
    access: "write",
    input: Schema.Struct({
      repo,
      tag: Schema.String,
      cleanupTag: Schema.optionalKey(Schema.Boolean),
    }),
    resource: (input, repo) => `${repo} ${input.tag}`,
    run: (input, call) =>
      withGh((gh) =>
        gh.execute(
          [
            "release",
            "delete",
            `--repo=${call.repo}`,
            "--yes",
            ...(input.cleanupTag ? ["--cleanup-tag"] : []),
            "--",
            input.tag,
          ],
          { cwd: call.cwd },
        ),
      ).pipe(Effect.asVoid),
  }),
  ghTool({
    name: "release_download",
    description:
      "Download a release's assets matching glob patterns into a directory, relative to the session directory.",
    access: "write",
    timeout: "10 minutes",
    input: Schema.Struct({
      repo,
      tag: Schema.String,
      patterns: Schema.Array(Schema.String).annotate({
        description: "Asset name globs, such as *.tar.gz",
      }),
      directory: Schema.String,
    }),
    run: (input, call) =>
      Release.download({ ...input, repo: call.repo }, { cwd: call.cwd }),
  }),
  ghTool({
    name: "run_cancel",
    description: "Cancel an Actions run that's queued or in progress.",
    access: "write",
    input: Schema.Struct({ repo, runId: Schema.Int }),
    run: (input, call) =>
      Workflow.cancel(
        { repo: call.repo, runId: input.runId },
        { cwd: call.cwd },
      ),
  }),
  ghTool({
    name: "repo_create",
    description:
      "Create a repository on GitHub, optionally from a template or with a README, .gitignore and licence, and return its URL. It isn't cloned; use repo_clone.",
    access: "write",
    repo: "none",
    input: Schema.Struct({
      name: Schema.String.annotate({
        description: "NAME for your account, or OWNER/NAME for an organisation",
      }),
      visibility: Schema.Literals(["public", "private", "internal"]),
      description: Schema.optionalKey(Schema.String),
      homepage: Schema.optionalKey(Schema.String),
      readme: Schema.optionalKey(Schema.Boolean).annotate({
        description: "Start it with a README",
      }),
      gitignore: Schema.optionalKey(Schema.String).annotate({
        description: "A .gitignore template, such as Node",
      }),
      license: Schema.optionalKey(Schema.String).annotate({
        description: "A licence key, such as mit",
      }),
      template: Schema.optionalKey(Schema.String).annotate({
        description: "An OWNER/REPO template to start from",
      }),
      disableIssues: Schema.optionalKey(Schema.Boolean),
      disableWiki: Schema.optionalKey(Schema.Boolean),
    }),
    resource: (input) => `${input.name} ${input.visibility}`,
    run: (input, call) =>
      withGh((gh) =>
        gh.execute(
          [
            "repo",
            "create",
            input.name,
            `--${input.visibility}`,
            ...flag("description", input.description),
            ...flag("homepage", input.homepage),
            ...(input.readme ? ["--add-readme"] : []),
            ...flag("gitignore", input.gitignore),
            ...flag("license", input.license),
            ...flag("template", input.template),
            ...(input.disableIssues ? ["--disable-issues"] : []),
            ...(input.disableWiki ? ["--disable-wiki"] : []),
          ],
          { cwd: call.cwd },
        ),
      ).pipe(Effect.map((output) => ({ url: output.stdout.trim() }))),
  }),
  ghTool({
    name: "repo_edit",
    description:
      "Change a repository's settings: rename it, its description, homepage, visibility, default branch, features (issues, discussions, wiki, projects), merge options, archived and template state, and topics. Returns the repository.",
    access: "write",
    input: Schema.Struct({
      repo,
      name: Schema.optionalKey(Schema.String).annotate({
        description: "A new name, renaming the repository",
      }),
      description: Schema.optionalKey(Schema.String),
      homepage: Schema.optionalKey(Schema.String),
      visibility: Schema.optionalKey(
        Schema.Literals(["public", "private", "internal"]),
      ),
      defaultBranch: Schema.optionalKey(Schema.String),
      hasIssues: Schema.optionalKey(Schema.Boolean),
      hasDiscussions: Schema.optionalKey(Schema.Boolean),
      hasWiki: Schema.optionalKey(Schema.Boolean),
      hasProjects: Schema.optionalKey(Schema.Boolean),
      allowSquashMerge: Schema.optionalKey(Schema.Boolean),
      allowMergeCommit: Schema.optionalKey(Schema.Boolean),
      allowRebaseMerge: Schema.optionalKey(Schema.Boolean),
      allowAutoMerge: Schema.optionalKey(Schema.Boolean),
      allowUpdateBranch: Schema.optionalKey(Schema.Boolean),
      deleteBranchOnMerge: Schema.optionalKey(Schema.Boolean),
      archived: Schema.optionalKey(Schema.Boolean).annotate({
        description: "Archive it, making it read-only, or unarchive it",
      }),
      isTemplate: Schema.optionalKey(Schema.Boolean),
      topics: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
        description: "Replace every topic with these",
      }),
    }),
    resource: (input, repo) =>
      [
        repo,
        ...(input.visibility === undefined ? [] : [input.visibility]),
        ...(input.archived ? ["archive"] : []),
      ].join(" "),
    run: ({ topics, ...input }, call) =>
      Effect.gen(function* () {
        const patch = Object.fromEntries(
          Object.entries({
            name: input.name,
            description: input.description,
            homepage: input.homepage,
            visibility: input.visibility,
            default_branch: input.defaultBranch,
            has_issues: input.hasIssues,
            has_discussions: input.hasDiscussions,
            has_wiki: input.hasWiki,
            has_projects: input.hasProjects,
            allow_squash_merge: input.allowSquashMerge,
            allow_merge_commit: input.allowMergeCommit,
            allow_rebase_merge: input.allowRebaseMerge,
            allow_auto_merge: input.allowAutoMerge,
            allow_update_branch: input.allowUpdateBranch,
            delete_branch_on_merge: input.deleteBranchOnMerge,
            archived: input.archived,
            is_template: input.isTemplate,
          }).flatMap(([key, value]) =>
            value === undefined ? [] : [[key, value] as const],
          ),
        );

        const changes = Object.keys(patch).length > 0;

        if (!changes && topics === undefined)
          return yield* new Tool.Error({ message: "Nothing to change" });

        if (topics !== undefined)
          yield* Api.empty(
            repoRequest(call.repo, "/topics", {
              method: "PUT",
              body: { names: topics },
              options: { cwd: call.cwd },
            }),
          );

        const response = yield* Api.json(
          repoRequest(
            call.repo,
            "",
            changes
              ? { method: "PATCH", body: patch, options: { cwd: call.cwd } }
              : { method: "GET", options: { cwd: call.cwd } },
          ),
          RepositoryResponse,
        );

        return repositorySummary(response);
      }),
  }),
  ghTool({
    name: "repo_delete",
    description:
      "Delete a repository for good. repo is required here, so it never falls back to the session directory's. Needs the delete_repo scope (gh auth refresh -s delete_repo).",
    access: "write",
    input: Schema.Struct({
      repo: Schema.String.annotate({
        description: "OWNER/REPO, or HOST/OWNER/REPO",
      }),
    }),
    run: (_, call) =>
      Api.empty(
        repoRequest(call.repo, "", {
          method: "DELETE",
          options: { cwd: call.cwd },
        }),
      ).pipe(
        Effect.mapError((error) =>
          error instanceof GhCommandError &&
          error.stdout.includes("Must have admin rights")
            ? new Tool.Error({
                message: `Deleting ${call.repo} needs admin rights and the delete_repo scope. Add the scope with: gh auth refresh -h github.com -s delete_repo`,
                error,
              })
            : error,
        ),
      ),
  }),
  ghTool({
    name: "repo_fork",
    description:
      "Fork a repository to your account or an organisation and return the fork. It isn't cloned; use repo_clone.",
    access: "write",
    input: Schema.Struct({
      repo,
      organization: Schema.optionalKey(Schema.String).annotate({
        description: "Fork into this organisation",
      }),
      name: Schema.optionalKey(Schema.String).annotate({
        description: "A name for the fork",
      }),
      defaultBranchOnly: Schema.optionalKey(Schema.Boolean),
    }),
    run: (input, call) =>
      Api.json(
        repoRequest(call.repo, "/forks", {
          method: "POST",
          body: Object.fromEntries(
            Object.entries({
              organization: input.organization,
              name: input.name,
              default_branch_only: input.defaultBranchOnly,
            }).flatMap(([key, value]) =>
              value === undefined ? [] : [[key, value] as const],
            ),
          ),
          options: { cwd: call.cwd },
        }),
        RepositoryResponse,
      ).pipe(Effect.map(repositorySummary)),
  }),
  ghTool({
    name: "repo_sync",
    description:
      "Bring a fork's branch up to date with its upstream repository on GitHub.",
    access: "write",
    input: Schema.Struct({
      repo: Schema.optionalKey(Schema.String).annotate({
        description:
          "The fork's OWNER/REPO. Defaults to the session directory's repository",
      }),
      branch: Schema.String,
    }),
    resource: (input, repo) => `${repo} ${input.branch}`,
    run: (input, call) =>
      Api.json(
        repoRequest(call.repo, "/merge-upstream", {
          method: "POST",
          body: { branch: input.branch },
          options: { cwd: call.cwd },
        }),
        Schema.Struct({
          message: Schema.String,
          merge_type: Schema.optionalKey(Schema.String),
        }),
      ),
  }),
  ghTool({
    name: "repo_clone",
    description:
      "Clone a repository into a directory, relative to the session directory.",
    access: "write",
    repo: "none",
    timeout: "10 minutes",
    input: Schema.Struct({
      repository: Schema.String.annotate({
        description: "OWNER/REPO or a clone URL",
      }),
      directory: Schema.String,
      depth: Schema.optionalKey(Schema.Int).annotate({
        description: "A shallow clone with this many commits",
      }),
    }),
    resource: (input) => input.repository,
    run: (input, call) =>
      Repository.clone(
        {
          repository: input.repository,
          directory: input.directory,
          gitArgs:
            input.depth === undefined ? undefined : [`--depth=${input.depth}`],
        },
        { cwd: call.cwd, env: { GIT_TERMINAL_PROMPT: "0" } },
      ).pipe(Effect.map(() => ({ directory: input.directory }))),
  }),
  ghTool({
    name: "upload_attachment",
    description:
      "Upload one file as a GitHub attachment and return its URL and Markdown. Prefer a write's attachments; the asset 404s until a post uses it.",
    access: "write",
    repo: "local",
    input: Schema.Struct({
      repo: Schema.optionalKey(Schema.String).annotate({
        description:
          "The OWNER/REPO the post is in. Defaults to the session directory's",
      }),
      path: Schema.String,
      alt: Schema.optionalKey(Schema.String),
      uploadRepository,
    }),
    run: (input, call) =>
      Effect.gen(function* () {
        const target =
          input.uploadRepository ??
          (yield* uploadTarget(
            call.repo || (yield* currentRepository(call.cwd)),
            call.cwd,
          ));

        const url = yield* Attachment.upload(
          { repository: target, path: input.path },
          { cwd: call.cwd },
        );

        return {
          url,
          repository: target,
          markdown: markdownLink(input.path, input.alt ?? "", url),
        };
      }),
  }),
  ghTool({
    name: "api",
    description:
      "Call the GitHub REST API, for what the typed tools don't cover. GET and HEAD run without asking; other methods ask. {owner} and {repo} in the endpoint are filled from the session directory's repository. Returns the JSON response, or text when it isn't JSON. Use graphql for GraphQL.",
    access: "read",
    repo: "none",
    timeout: "5 minutes",
    input: Schema.Struct({
      endpoint: Schema.String.annotate({
        description: "A path such as repos/{owner}/{repo}/pulls, or a full URL",
      }),
      method: Schema.optionalKey(
        Schema.Literals(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
      ).annotate({
        description: "GET by default",
      }),
      query: Schema.optionalKey(
        Schema.Record(
          Schema.String,
          Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
        ),
      ),
      headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      body: Schema.optionalKey(Schema.Json).annotate({
        description: "The JSON request body",
      }),
      paginate: Schema.optionalKey(Schema.Boolean).annotate({
        description: "Fetch every page of a GET, returned as an array of pages",
      }),
    }),
    classify: (input) => {
      const method = input.method ?? "GET";

      if (/^\/?graphql(?:[?#]|$)/.test(input.endpoint))
        return Effect.fail(
          new Tool.Error({ message: "Use the graphql tool for GraphQL" }),
        );

      return Effect.succeed({
        access: method === "GET" || method === "HEAD" ? "read" : "write",
        resource: `${method} ${endpointPattern(input.endpoint)}`,
      });
    },
    run: ({ paginate, body: requestBody, ...input }, call) => {
      const request = {
        ...input,
        method: input.method ?? "GET",
        options: { cwd: call.cwd },
      };

      if (paginate && requestBody === undefined && request.method === "GET")
        return Api.pages({ ...request, method: "GET" }, Schema.Unknown);

      return Api.text(
        requestBody === undefined ? request : { ...request, body: requestBody },
      ).pipe(
        Effect.map((output) =>
          Option.getOrElse(
            Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(
              output,
            ),
            () => output,
          ),
        ),
      );
    },
  }),
  ghTool({
    name: "graphql",
    description:
      "Run a GitHub GraphQL document, for what the typed tools don't cover. Query-only documents run without asking; mutations ask. Returns the response's data.",
    access: "read",
    repo: "none",
    input: Schema.Struct({
      document: Schema.String.annotate({
        description: "The GraphQL query or mutation",
      }),
      variables: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
    }),
    classify: (input) =>
      Graphql.operations(input.document).pipe(
        Effect.flatMap((operations) => {
          if (operations.length === 0)
            return Effect.fail(
              new Tool.Error({ message: "The document has no operation" }),
            );

          if (operations.some((operation) => operation.kind === "subscription"))
            return Effect.fail(
              new Tool.Error({ message: "Subscriptions aren't supported" }),
            );

          const writes = operations.filter(
            (operation) => operation.kind === "mutation",
          );

          return Effect.succeed({
            access:
              writes.length === 0 ? ("read" as const) : ("write" as const),
            resource:
              writes.length === 0
                ? `query ${operations.flatMap((operation) => operation.fields).join(",")}`
                : `mutation ${writes.flatMap((operation) => operation.fields).join(",")}`,
          });
        }),
      ),
    run: (input, call) =>
      Graphql.query(input.document, input.variables, Schema.Unknown, {
        cwd: call.cwd,
      }),
  }),
  ghTool({
    name: "project_list",
    description:
      "List an owner's projects, your own by default, 30 by default.",
    access: "read",
    repo: "none",
    input: Schema.Struct({
      owner: projectOwner,
      limit: Schema.optionalKey(Schema.Int),
      closed: Schema.optionalKey(Schema.Boolean).annotate({
        description: "Include closed projects",
      }),
    }),
    run: (input, call) => Project.list(input, { cwd: call.cwd }),
  }),
  ghTool({
    name: "project_view",
    description:
      "View a project: its title, description, readme, visibility and item and field counts.",
    access: "read",
    repo: "none",
    input: Schema.Struct({ number: number("project"), owner: projectOwner }),
    run: (input, call) => Project.view(input, { cwd: call.cwd }),
  }),
  ghTool({
    name: "project_field_list",
    description:
      "List a project's fields, with the options of single select fields.",
    access: "read",
    repo: "none",
    input: Schema.Struct({
      number: number("project"),
      owner: projectOwner,
      limit: Schema.optionalKey(Schema.Int),
    }),
    run: (input, call) => Project.fieldList(input, { cwd: call.cwd }),
  }),
  ghTool({
    name: "project_item_list",
    description:
      "List a project's items, 30 by default, optionally filtered with a Projects query.",
    access: "read",
    repo: "none",
    input: Schema.Struct({
      number: number("project"),
      owner: projectOwner,
      limit: Schema.optionalKey(Schema.Int),
      query: Schema.optionalKey(Schema.String).annotate({
        description: "A Projects filter, such as assignee:octocat -status:Done",
      }),
    }),
    run: (input, call) => Project.itemList(input, { cwd: call.cwd }),
  }),
  ghTool({
    name: "codespace_list",
    description:
      "List your codespaces with their state, repository, machine and git status.",
    access: "read",
    repo: "local",
    input: Schema.Struct({
      repo,
      limit: Schema.optionalKey(Schema.Int),
      org: Schema.optionalKey(Schema.String).annotate({
        description: "List an organisation's codespaces (admins only)",
      }),
      user: Schema.optionalKey(Schema.String).annotate({
        description: "With org, the user whose codespaces to list",
      }),
    }),
    run: (input, call) => Codespace.list(input, { cwd: call.cwd }),
  }),
  ghTool({
    name: "codespace_view",
    description: "View a codespace by name, from codespace_list.",
    access: "read",
    repo: "none",
    input: Schema.Struct({ codespace: Schema.String }),
    run: (input, call) => Codespace.view(input, { cwd: call.cwd }),
  }),
  ghTool({
    name: "gist_list",
    description: "List your gists, 10 by default.",
    access: "read",
    repo: "none",
    input: Schema.Struct({
      limit: Schema.optionalKey(Schema.Int),
      filter: Schema.optionalKey(Schema.String).annotate({
        description:
          "A regular expression the description or a file name must match",
      }),
      visibility: Schema.optionalKey(Schema.Literals(["public", "secret"])),
    }),
    run: (input, call) => Gist.list(input, { cwd: call.cwd }),
  }),
  ghTool({
    name: "gist_view",
    description: "Read a gist's raw contents, or one file's.",
    access: "read",
    repo: "none",
    input: Schema.Struct({
      gist: Schema.String.annotate({ description: "The gist's ID or URL" }),
      filename: Schema.optionalKey(Schema.String),
    }),
    run: (input, call) => Gist.view(input, { cwd: call.cwd }),
  }),
  ghTool({
    name: "ssh_key_list",
    description: "List the SSH keys on your account.",
    access: "read",
    repo: "none",
    input: Schema.Struct({}),
    run: (_input, call) => SshKey.list({ cwd: call.cwd }),
  }),
  ghTool({
    name: "gpg_key_list",
    description: "List the GPG keys on your account.",
    access: "read",
    repo: "none",
    input: Schema.Struct({}),
    run: (_input, call) => GpgKey.list({ cwd: call.cwd }),
  }),
  ghTool({
    name: "repo_deploy_key_list",
    description: "List a repository's deploy keys.",
    access: "read",
    repo: "local",
    input: Schema.Struct({ repo }),
    run: (input, call) => DeployKey.list(input, { cwd: call.cwd }),
  }),
  ghTool({
    name: "ruleset_list",
    description:
      "List a repository's or organisation's rulesets, as gh prints them.",
    access: "read",
    repo: "local",
    input: Schema.Struct({
      repo,
      org: Schema.optionalKey(Schema.String).annotate({
        description:
          "List an organisation's rulesets instead, which needs the admin:org scope",
      }),
      limit: Schema.optionalKey(Schema.Int),
      parents: rulesetParents,
    }),
    run: (input, call) => Ruleset.list(input, { cwd: call.cwd }),
  }),
  ghTool({
    name: "ruleset_view",
    description: "View a ruleset by ID, from ruleset_list, as gh prints it.",
    access: "read",
    repo: "local",
    input: Schema.Struct({
      repo,
      id: Schema.Int,
      org: Schema.optionalKey(Schema.String).annotate({
        description: "The organisation, for an organisation-level ruleset",
      }),
      parents: rulesetParents,
    }),
    run: (input, call) => Ruleset.view(input, { cwd: call.cwd }),
  }),
  ghTool({
    name: "ruleset_check",
    description:
      "The rules that apply to a branch, which need not exist, as gh prints them.",
    access: "read",
    repo: "local",
    input: Schema.Struct({
      repo,
      branch: Schema.optionalKey(Schema.String).annotate({
        description:
          "The branch; the session directory's current branch without it",
      }),
      default: Schema.optionalKey(Schema.Boolean).annotate({
        description: "Check the default branch instead",
      }),
    }),
    run: (input, call) => Ruleset.check(input, { cwd: call.cwd }),
  }),
  ghTool({
    name: "repo_autolink_list",
    description:
      "List a repository's autolink references. Only administrators can read them.",
    access: "read",
    repo: "local",
    input: Schema.Struct({ repo }),
    run: (input, call) => Autolink.list(input, { cwd: call.cwd }),
  }),
  ghTool({
    name: "repo_autolink_view",
    description: "View an autolink reference by ID, from repo_autolink_list.",
    access: "read",
    repo: "local",
    input: Schema.Struct({ repo, id: Schema.Int }),
    run: (input, call) => Autolink.view(input, { cwd: call.cwd }),
  }),
  ghTool({
    name: "agent_task_list",
    description: "List your recent Copilot agent tasks, newest first.",
    access: "read",
    repo: "none",
    input: Schema.Struct({ limit: Schema.optionalKey(Schema.Int) }),
    run: (input, call) => AgentTask.list(input, { cwd: call.cwd }),
  }),
  ghTool({
    name: "agent_task_view",
    description:
      "View a Copilot agent task by session ID, pull request number, URL or branch.",
    access: "read",
    repo: "local",
    input: Schema.Struct({
      repo,
      task: Schema.Union([Schema.Int, Schema.String]),
    }),
    run: (input, call) => AgentTask.view(input, { cwd: call.cwd }),
  }),
  ghTool({
    name: "skill_list",
    description: "List the agent skills gh has installed.",
    access: "read",
    repo: "none",
    input: Schema.Struct({
      agent: Schema.optionalKey(Schema.String).annotate({
        description: "The target agent, such as github-copilot or claude-code",
      }),
      scope: Schema.optionalKey(Schema.Literals(["project", "user"])),
      dir: Schema.optionalKey(Schema.String).annotate({
        description: "Scan this directory instead",
      }),
    }),
    run: (input, call) => Skill.list(input, { cwd: call.cwd }),
  }),
  ghTool({
    name: "skill_search",
    description: "Search GitHub repositories for agent skills.",
    access: "read",
    repo: "none",
    input: Schema.Struct({
      query: Schema.String,
      owner: Schema.optionalKey(Schema.String),
      limit: Schema.optionalKey(Schema.Int).annotate({
        description: "Results per page, 15 by default",
      }),
      page: Schema.optionalKey(Schema.Int),
    }),
    run: (input, call) => Skill.search(input, { cwd: call.cwd }),
  }),
  ghTool({
    name: "skill_preview",
    description:
      "Read a skill's SKILL.md from a repository without installing it.",
    access: "read",
    repo: "none",
    input: Schema.Struct({
      repository: Schema.String.annotate({
        description: "The OWNER/REPO the skill is in",
      }),
      skill: Schema.String,
      allowHiddenDirs: Schema.optionalKey(Schema.Boolean),
    }),
    run: (input, call) => Skill.preview(input, { cwd: call.cwd }),
  }),
  ghTool({
    name: "config_get",
    description:
      "Read one of gh's configuration keys, optionally for one host.",
    access: "read",
    repo: "none",
    input: Schema.Struct({
      key: Schema.String,
      host: Schema.optionalKey(Schema.String),
    }),
    run: (input, call) => Config.get(input, { cwd: call.cwd }),
  }),
  ghTool({
    name: "config_list",
    description:
      "List gh's configuration keys and values, optionally for one host.",
    access: "read",
    repo: "none",
    input: Schema.Struct({ host: Schema.optionalKey(Schema.String) }),
    run: (input, call) => Config.list(input, { cwd: call.cwd }),
  }),
  ghTool({
    name: "alias_list",
    description: "List gh's aliases, as a YAML map of alias to expansion.",
    access: "read",
    repo: "none",
    input: Schema.Struct({}),
    run: (_input, call) => Alias.list({ cwd: call.cwd }),
  }),
  ghTool({
    name: "org_list",
    description: "List the logins of your organisations, 30 by default.",
    access: "read",
    repo: "none",
    input: Schema.Struct({ limit: Schema.optionalKey(Schema.Int) }),
    run: (input, call) => Org.list(input, { cwd: call.cwd }),
  }),
  ghTool({
    name: "status",
    description:
      "Your GitHub status as gh's text report: assigned issues and pull requests, review requests, mentions and repository activity.",
    access: "read",
    repo: "none",
    input: Schema.Struct({
      exclude: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
        description: "Repositories to leave out, as OWNER/REPO",
      }),
      org: Schema.optionalKey(Schema.String).annotate({
        description: "Only this organisation's activity",
      }),
    }),
    run: (input, call) => Status.get(input, { cwd: call.cwd }),
  }),
  ghTool({
    name: "repo_gitignore_list",
    description: "List the .gitignore templates GitHub offers.",
    access: "read",
    repo: "none",
    input: Schema.Struct({}),
    run: (_input, call) => Template.gitignoreList({ cwd: call.cwd }),
  }),
  ghTool({
    name: "repo_gitignore_view",
    description:
      "Read a .gitignore template by its case-sensitive name, such as Go.",
    access: "read",
    repo: "none",
    input: Schema.Struct({ name: Schema.String }),
    run: (input, call) => Template.gitignoreView(input, { cwd: call.cwd }),
  }),
  ghTool({
    name: "repo_license_list",
    description: "List the common licences GitHub offers.",
    access: "read",
    repo: "none",
    input: Schema.Struct({}),
    run: (_input, call) => Template.licenseList({ cwd: call.cwd }),
  }),
  ghTool({
    name: "repo_license_view",
    description:
      "Read a licence's text by its key or SPDX ID, such as mit or AGPL-3.0.",
    access: "read",
    repo: "none",
    input: Schema.Struct({ license: Schema.String }),
    run: (input, call) => Template.licenseView(input, { cwd: call.cwd }),
  }),
];
