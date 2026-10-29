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
