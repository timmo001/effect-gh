import { Effect, Schema } from "effect";
import { Gh, type GhOptions } from "./gh.js";

export const Repository = Schema.Struct({
  nameWithOwner: Schema.String,
  url: Schema.String,
  defaultBranchRef: Schema.NullOr(Schema.Struct({ name: Schema.String })),
  isPrivate: Schema.Boolean,
});

export interface Repository extends Schema.Schema.Type<typeof Repository> {}

/** View [HOST/]OWNER/REPO, or the repository selected by the working directory. */
export const view = Effect.fn("Repository.view")(function* (
  repo?: string,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  const args = [
    "repo",
    "view",
    "--json",
    "nameWithOwner,url,defaultBranchRef,isPrivate",
  ];

  if (repo !== undefined) args.push("--", repo);

  return yield* gh.json(args, Repository, options);
});

/** Input for {@link clone} and {@link cloneInteractive}. */
export interface CloneInput {
  /** [HOST/]OWNER/REPO or a clone URL. */
  readonly repository: string;
  readonly directory: string;
  /** Extra `git clone` flags, such as `--depth 1`. */
  readonly gitArgs?: ReadonlyArray<string>;
}

const cloneArgs = (input: CloneInput) => [
  "repo",
  "clone",
  input.repository,
  input.directory,
  ...(input.gitArgs?.length ? ["--", ...input.gitArgs] : []),
];

/** Clone with captured output. Captured stdio cannot answer prompts, so pass non-interactive git settings in `env`. */
export const clone = Effect.fn("Repository.clone")(function* (
  input: CloneInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;
  const output = yield* gh.execute(cloneArgs(input), options);

  return { stdout: output.stdout, stderr: output.stderr };
});

/** Clone on the terminal, so git can show progress and ask for credentials. */
export const cloneInteractive = Effect.fn("Repository.cloneInteractive")(
  function* (
    input: CloneInput,
    options?: Omit<GhOptions, "stdin" | "maxOutputBytes">,
  ) {
    const gh = yield* Gh;

    yield* gh.interactive(cloneArgs(input), options);
  },
);

/** Input for {@link readFile} and {@link readDir}; gh's preview `repo read-file` and `read-dir`. */
export interface ReadInput {
  /** [HOST/]OWNER/REPO; the working directory's repository without it. */
  readonly repo?: string;
  readonly path: string;
  /** Branch, tag or commit; the default branch without it. */
  readonly ref?: string;
}

const readArgs = (command: string, input: Omit<ReadInput, "path">) => [
  "repo",
  command,
  ...(input.repo === undefined ? [] : ["--repo", input.repo]),
  ...(input.ref === undefined ? [] : ["--ref", input.ref]),
];

/**
 * Read a text file without cloning. Escape sequences are kept, since the
 * output is captured rather than printed to a terminal.
 */
export const readFile = Effect.fn("Repository.readFile")(function* (
  input: ReadInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  const output = yield* gh.execute(
    [
      ...readArgs("read-file", input),
      "--allow-escape-sequences",
      "--",
      input.path,
    ],
    options,
  );

  return output.stdout;
});

/** One entry of a directory listing from {@link readDir}. */
export const DirectoryEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  type: Schema.Literals(["file", "dir", "symlink", "submodule", "unknown"]),
  size: Schema.Int,
  gitSHA: Schema.String,
  /** Octal Git file mode, such as `100644`. */
  modeOctal: Schema.String,
});

export interface DirectoryEntry extends Schema.Schema.Type<
  typeof DirectoryEntry
> {}

/** List a directory without cloning, or the root when `path` is omitted. */
export const readDir = Effect.fn("Repository.readDir")(function* (
  input: Omit<ReadInput, "path"> & { readonly path?: string },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  const result = yield* gh.json(
    [
      ...readArgs("read-dir", input),
      "--json",
      "name,path,type,size,gitSHA,modeOctal",
      ...(input.path === undefined ? [] : ["--", input.path]),
    ],
    Schema.Struct({ entries: Schema.Array(DirectoryEntry) }),
    options,
  );

  return result.entries;
});

/** Open a repository, or one of its sections, in the browser. */
export const browse = Effect.fn("Repository.browse")(function* (
  input: {
    readonly repo: string;
    readonly section?:
      "actions" | "projects" | "releases" | "settings" | "wiki";
  },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "browse",
      ...(input.section === undefined ? [] : [`--${input.section}`]),
      "--repo",
      input.repo,
    ],
    options,
  );
});

/** `--repo` arguments; gh selects the working directory's repository without them. */
const repoArgs = (repo: string | undefined) =>
  repo === undefined ? [] : ["--repo", repo];

/** A trailing `-- <repository>` positional, or nothing for the working directory's repository. */
const positional = (repo: string | undefined) =>
  repo === undefined ? [] : ["--", repo];

/** `--flag=value` for a boolean setting, or nothing when it is not set. */
const toggle = (flag: string, value: boolean | undefined) =>
  value === undefined ? [] : [`--${flag}=${value}`];

/** Input for {@link create}. */
export interface CreateInput {
  /** `[OWNER/]REPO`. Defaults to the source directory's name with `source`. */
  readonly name?: string;
  readonly visibility: "public" | "private" | "internal";
  readonly description?: string;
  readonly homepage?: string;
  /** Add a README file to the new repository. */
  readonly addReadme?: boolean;
  /** `.gitignore` template name, as `gh repo gitignore list` shows. */
  readonly gitignore?: string;
  /** Licence key or SPDX ID, as `gh repo license list` shows. */
  readonly license?: string;
  readonly disableIssues?: boolean;
  readonly disableWiki?: boolean;
  /** Create the repository from this template repository. */
  readonly template?: string;
  /** Include all branches from the template repository. */
  readonly includeAllBranches?: boolean;
  /** The organisation team to grant access. */
  readonly team?: string;
  /** Use this local repository as the source. */
  readonly source?: string;
  /** Name of the remote added for the new repository. */
  readonly remote?: string;
  /** Push local commits to the new repository. */
  readonly push?: boolean;
  /** Clone the new repository into the working directory. */
  readonly clone?: boolean;
}

/** Create a repository non-interactively and return its URL. */
export const create = Effect.fn("Repository.create")(function* (
  input: CreateInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  const output = yield* gh.execute(
    [
      "repo",
      "create",
      `--${input.visibility}`,
      ...(input.description === undefined
        ? []
        : ["--description", input.description]),
      ...(input.homepage === undefined ? [] : ["--homepage", input.homepage]),
      ...(input.addReadme ? ["--add-readme"] : []),
      ...(input.gitignore === undefined
        ? []
        : ["--gitignore", input.gitignore]),
      ...(input.license === undefined ? [] : ["--license", input.license]),
      ...(input.disableIssues ? ["--disable-issues"] : []),
      ...(input.disableWiki ? ["--disable-wiki"] : []),
      ...(input.template === undefined ? [] : ["--template", input.template]),
      ...(input.includeAllBranches ? ["--include-all-branches"] : []),
      ...(input.team === undefined ? [] : ["--team", input.team]),
      ...(input.source === undefined ? [] : ["--source", input.source]),
      ...(input.remote === undefined ? [] : ["--remote", input.remote]),
      ...(input.push ? ["--push"] : []),
      ...(input.clone ? ["--clone"] : []),
      ...(input.name === undefined ? [] : ["--", input.name]),
    ],
    options,
  );

  return { url: output.stdout.trim().split("\n").at(-1) ?? "" };
});

/**
 * Delete a repository without prompting. gh ignores `--yes` without an
 * explicit repository, so `repo` is required, and the token needs the
 * `delete_repo` scope. From gh 2.104.0, deleting a private or internal
 * repository that has forks fails unless
 * `acceptCascadingDeletionOfPrivateForks` is set, since it deletes them too.
 */
export const remove = Effect.fn("Repository.remove")(function* (
  input: {
    readonly repo: string;
    readonly acceptCascadingDeletionOfPrivateForks?: boolean;
  },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "repo",
      "delete",
      "--yes",
      ...(input.acceptCascadingDeletionOfPrivateForks
        ? ["--accept-cascading-deletion-of-private-forks"]
        : []),
      "--",
      input.repo,
    ],
    options,
  );
});

/** Input for {@link edit}. */
export interface EditInput {
  /** [HOST/]OWNER/REPO; the working directory's repository without it. */
  readonly repo?: string;
  readonly description?: string;
  readonly homepage?: string;
  readonly defaultBranch?: string;
  /**
   * Changing visibility has consequences, such as losing stars and
   * watchers, so setting it also passes
   * `--accept-visibility-change-consequences`.
   */
  readonly visibility?: "public" | "private" | "internal";
  readonly addTopics?: ReadonlyArray<string>;
  readonly removeTopics?: ReadonlyArray<string>;
  readonly squashMergeCommitMessage?:
    "default" | "pr-title" | "pr-title-commits" | "pr-title-description";
  /** Each of these turns the setting on with `true` and off with `false`. */
  readonly allowForking?: boolean;
  readonly allowUpdateBranch?: boolean;
  readonly deleteBranchOnMerge?: boolean;
  readonly enableAdvancedSecurity?: boolean;
  readonly enableAutoMerge?: boolean;
  readonly enableDiscussions?: boolean;
  readonly enableIssues?: boolean;
  readonly enableMergeCommit?: boolean;
  readonly enableProjects?: boolean;
  readonly enableRebaseMerge?: boolean;
  readonly enableSecretScanning?: boolean;
  readonly enableSecretScanningPushProtection?: boolean;
  readonly enableSquashMerge?: boolean;
  readonly enableWiki?: boolean;
  /** Make the repository available as a template repository. */
  readonly template?: boolean;
}

/** Change a repository's settings; only the settings given are touched. */
export const edit = Effect.fn("Repository.edit")(function* (
  input: EditInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "repo",
      "edit",
      ...(input.description === undefined
        ? []
        : ["--description", input.description]),
      ...(input.homepage === undefined ? [] : ["--homepage", input.homepage]),
      ...(input.defaultBranch === undefined
        ? []
        : ["--default-branch", input.defaultBranch]),
      ...(input.visibility === undefined
        ? []
        : [
            "--visibility",
            input.visibility,
            "--accept-visibility-change-consequences",
          ]),
      ...(input.addTopics ?? []).flatMap((topic) => ["--add-topic", topic]),
      ...(input.removeTopics ?? []).flatMap((topic) => [
        "--remove-topic",
        topic,
      ]),
      ...(input.squashMergeCommitMessage === undefined
        ? []
        : ["--squash-merge-commit-message", input.squashMergeCommitMessage]),
      ...toggle("allow-forking", input.allowForking),
      ...toggle("allow-update-branch", input.allowUpdateBranch),
      ...toggle("delete-branch-on-merge", input.deleteBranchOnMerge),
      ...toggle("enable-advanced-security", input.enableAdvancedSecurity),
      ...toggle("enable-auto-merge", input.enableAutoMerge),
      ...toggle("enable-discussions", input.enableDiscussions),
      ...toggle("enable-issues", input.enableIssues),
      ...toggle("enable-merge-commit", input.enableMergeCommit),
      ...toggle("enable-projects", input.enableProjects),
      ...toggle("enable-rebase-merge", input.enableRebaseMerge),
      ...toggle("enable-secret-scanning", input.enableSecretScanning),
      ...toggle(
        "enable-secret-scanning-push-protection",
        input.enableSecretScanningPushProtection,
      ),
      ...toggle("enable-squash-merge", input.enableSquashMerge),
      ...toggle("enable-wiki", input.enableWiki),
      ...toggle("template", input.template),
      ...positional(input.repo),
    ],
    options,
  );
});

/** Input for {@link fork}. */
export interface ForkInput {
  /** [HOST/]OWNER/REPO or a URL; the working directory's repository without it. */
  readonly repo?: string;
  /** Create the fork in this organisation. */
  readonly org?: string;
  readonly forkName?: string;
  readonly defaultBranchOnly?: boolean;
  /** Clone the fork. Off by default, so gh never prompts. */
  readonly clone?: boolean;
  /** Add a git remote for the fork. Off by default, so gh never prompts. */
  readonly remote?: boolean;
  /** Name of that remote; `origin` by default. */
  readonly remoteName?: string;
  /** Extra `git clone` flags, used with `clone`. */
  readonly gitArgs?: ReadonlyArray<string>;
}

/** Fork a repository. */
export const fork = Effect.fn("Repository.fork")(function* (
  input: ForkInput = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "repo",
      "fork",
      ...(input.repo === undefined ? [] : [input.repo]),
      ...(input.org === undefined ? [] : ["--org", input.org]),
      ...(input.forkName === undefined ? [] : ["--fork-name", input.forkName]),
      ...(input.defaultBranchOnly ? ["--default-branch-only"] : []),
      `--clone=${input.clone ?? false}`,
      `--remote=${input.remote ?? false}`,
      ...(input.remoteName === undefined
        ? []
        : ["--remote-name", input.remoteName]),
      ...(input.gitArgs?.length ? ["--", ...input.gitArgs] : []),
    ],
    options,
  );
});

/** A repository as `gh repo list --json` returns it. */
export const ListItem = Schema.Struct({
  name: Schema.String,
  nameWithOwner: Schema.String,
  description: Schema.String,
  url: Schema.String,
  /** `PUBLIC`, `PRIVATE` or `INTERNAL`. */
  visibility: Schema.String,
  isPrivate: Schema.Boolean,
  isFork: Schema.Boolean,
  isArchived: Schema.Boolean,
  updatedAt: Schema.String,
});

export interface ListItem extends Schema.Schema.Type<typeof ListItem> {}

/** Input for {@link list}. */
export interface ListInput {
  /** A user or organisation; the authenticated user without it. */
  readonly owner?: string;
  /** At most this many repositories, 30 by default. */
  readonly limit?: number;
  readonly visibility?: "public" | "private" | "internal";
  /** Only forks (`true`) or only non-forks (`false`). */
  readonly fork?: boolean;
  /** Only archived (`true`) or only non-archived (`false`) repositories. */
  readonly archived?: boolean;
  readonly language?: string;
  readonly topics?: ReadonlyArray<string>;
}

/** List the repositories a user or organisation owns. */
export const list = Effect.fn("Repository.list")(function* (
  input: ListInput = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "repo",
      "list",
      ...(input.limit === undefined ? [] : ["--limit", String(input.limit)]),
      ...(input.visibility === undefined
        ? []
        : ["--visibility", input.visibility]),
      ...(input.fork === undefined ? [] : [input.fork ? "--fork" : "--source"]),
      ...(input.archived === undefined
        ? []
        : [input.archived ? "--archived" : "--no-archived"]),
      ...(input.language === undefined ? [] : ["--language", input.language]),
      ...(input.topics ?? []).flatMap((topic) => ["--topic", topic]),
      "--json",
      Object.keys(ListItem.fields).join(","),
      ...(input.owner === undefined ? [] : ["--", input.owner]),
    ],
    Schema.Array(ListItem),
    options,
  );
});

/** Archive a repository without prompting. */
export const archive = Effect.fn("Repository.archive")(function* (
  input: { readonly repo?: string } = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    ["repo", "archive", "--yes", ...positional(input.repo)],
    options,
  );
});

/** Unarchive a repository without prompting. */
export const unarchive = Effect.fn("Repository.unarchive")(function* (
  input: { readonly repo?: string } = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    ["repo", "unarchive", "--yes", ...positional(input.repo)],
    options,
  );
});

/** Rename a repository without prompting; `newName` has no owner. */
export const rename = Effect.fn("Repository.rename")(function* (
  input: { readonly repo?: string; readonly newName: string },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    ["repo", "rename", "--yes", ...repoArgs(input.repo), "--", input.newName],
    options,
  );
});

/** Set the working directory's default repository, from `OWNER/REPO` or a git remote name. */
export const setDefault = Effect.fn("Repository.setDefault")(function* (
  input: { readonly repo: string },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(["repo", "set-default", "--", input.repo], options);
});

/** Unset the working directory's default repository. */
export const unsetDefault = Effect.fn("Repository.unsetDefault")(function* (
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(["repo", "set-default", "--unset"], options);
});

/** The working directory's default repository, as gh prints it. */
export const viewDefault = Effect.fn("Repository.viewDefault")(function* (
  options?: GhOptions,
) {
  const gh = yield* Gh;
  const output = yield* gh.execute(["repo", "set-default", "--view"], options);

  return output.stdout.trim();
});

/** Input for {@link sync}. */
export interface SyncInput {
  /** The destination, [HOST/]OWNER/REPO; the working directory's repository without it. */
  readonly repo?: string;
  /** The source repository; the destination's parent without it. */
  readonly source?: string;
  /** The branch to sync; the default branch without it. */
  readonly branch?: string;
  /** Hard reset the destination branch instead of fast-forwarding. */
  readonly force?: boolean;
}

/** Sync a repository's branch from its parent or another repository. */
export const sync = Effect.fn("Repository.sync")(function* (
  input: SyncInput = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "repo",
      "sync",
      ...(input.source === undefined ? [] : ["--source", input.source]),
      ...(input.branch === undefined ? [] : ["--branch", input.branch]),
      ...(input.force ? ["--force"] : []),
      ...positional(input.repo),
    ],
    options,
  );
});
