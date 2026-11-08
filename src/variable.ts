import { Effect, Schema } from "effect";
import { Gh, type GhOptions } from "./gh.js";

/** An Actions variable as `gh variable list` and `gh variable get` return it. */
export const Variable = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  /** Empty for repository and environment variables. */
  visibility: Schema.String,
  numSelectedRepos: Schema.Int,
  selectedReposURL: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export interface Variable extends Schema.Schema.Type<typeof Variable> {}

/**
 * Where a variable lives: the repository by default, or one of an environment
 * or an organisation. Pick at most one of `environment` and `organization`.
 */
export interface Level {
  readonly repo?: string;
  readonly environment?: string;
  readonly organization?: string;
}

const levelArgs = (level: Level) => [
  ...(level.repo === undefined ? [] : ["--repo", level.repo]),
  ...(level.environment === undefined ? [] : ["--env", level.environment]),
  ...(level.organization === undefined ? [] : ["--org", level.organization]),
];

const fields = Object.keys(Variable.fields).join(",");

/** List variables at a level. */
export const list = Effect.fn("Variable.list")(function* (
  input: Level = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    ["variable", "list", ...levelArgs(input), "--json", fields],
    Schema.Array(Variable),
    options,
  );
});

/** Read one variable. */
export const get = Effect.fn("Variable.get")(function* (
  input: Level & { readonly name: string },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "variable",
      "get",
      ...levelArgs(input),
      "--json",
      fields,
      "--",
      input.name,
    ],
    Variable,
    options,
  );
});

/** Input for {@link set}. */
export interface SetInput extends Level {
  readonly name: string;
  /** Sent through stdin. */
  readonly value: string;
  /** Organisation variable visibility, `private` by default. */
  readonly visibility?: "all" | "private" | "selected";
  /** Repositories that can access an organisation variable. */
  readonly repos?: ReadonlyArray<string>;
}

/** Create or update a variable. */
export const set = Effect.fn("Variable.set")(function* (
  input: SetInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "variable",
      "set",
      ...levelArgs(input),
      ...(input.visibility === undefined
        ? []
        : ["--visibility", input.visibility]),
      ...(input.repos === undefined ? [] : ["--repos", input.repos.join(",")]),
      "--",
      input.name,
    ],
    { ...options, stdin: input.value },
  );
});

/** Delete a variable. */
export const remove = Effect.fn("Variable.remove")(function* (
  input: Level & { readonly name: string },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    ["variable", "delete", ...levelArgs(input), "--", input.name],
    options,
  );
});
