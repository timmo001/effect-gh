import { Effect, Schema } from "effect";
import { Gh, type GhOptions } from "./gh.js";

/** A secret as `gh secret list` returns it. Names only; values are never readable. */
export const Item = Schema.Struct({
  name: Schema.String,
  /** Empty for repository, environment and user secrets without a visibility. */
  visibility: Schema.String,
  numSelectedRepos: Schema.Int,
  selectedReposURL: Schema.String,
  updatedAt: Schema.String,
});

export interface Item extends Schema.Schema.Type<typeof Item> {}

export type App = "actions" | "agents" | "codespaces" | "dependabot";

/**
 * Where a secret lives: the repository by default, or one of an environment,
 * an organisation or the user. Pick at most one of `environment`,
 * `organization` and `user`.
 */
export interface Level {
  readonly repo?: string;
  readonly environment?: string;
  readonly organization?: string;
  readonly user?: boolean;
  readonly app?: App;
}

const levelArgs = (level: Level) => [
  ...(level.repo === undefined ? [] : ["--repo", level.repo]),
  ...(level.environment === undefined ? [] : ["--env", level.environment]),
  ...(level.organization === undefined ? [] : ["--org", level.organization]),
  ...(level.user ? ["--user"] : []),
  ...(level.app === undefined ? [] : ["--app", level.app]),
];

/** List secret names at a level. */
export const list = Effect.fn("Secret.list")(function* (
  input: Level = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "secret",
      "list",
      ...levelArgs(input),
      "--json",
      Object.keys(Item.fields).join(","),
    ],
    Schema.Array(Item),
    options,
  );
});

/** Input for {@link set}. */
export interface SetInput extends Level {
  readonly name: string;
  /** Sent through stdin, so it never appears in the process arguments. */
  readonly value: string;
  /** Organisation secret visibility, `private` by default. */
  readonly visibility?: "all" | "private" | "selected";
  /** Repositories that can access an organisation or user secret. */
  readonly repos?: ReadonlyArray<string>;
  /** Let no repository access the organisation secret. */
  readonly noReposSelected?: boolean;
}

/** Set a secret, encrypted locally by gh before it is sent. */
export const set = Effect.fn("Secret.set")(function* (
  input: SetInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "secret",
      "set",
      ...levelArgs(input),
      ...(input.visibility === undefined
        ? []
        : ["--visibility", input.visibility]),
      ...(input.repos === undefined ? [] : ["--repos", input.repos.join(",")]),
      ...(input.noReposSelected ? ["--no-repos-selected"] : []),
      "--",
      input.name,
    ],
    { ...options, stdin: input.value },
  );
});

/** Delete a secret. */
export const remove = Effect.fn("Secret.remove")(function* (
  input: Level & { readonly name: string },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    ["secret", "delete", ...levelArgs(input), "--", input.name],
    options,
  );
});
