import { Effect, Schema } from "effect";
import { Gh, type GhOptions } from "./gh.js";

/** A GitHub Actions cache as `gh cache list` returns it. */
export const Item = Schema.Struct({
  id: Schema.Int,
  key: Schema.String,
  ref: Schema.String,
  version: Schema.String,
  sizeInBytes: Schema.Int,
  createdAt: Schema.String,
  lastAccessedAt: Schema.String,
});

export interface Item extends Schema.Schema.Type<typeof Item> {}

/** `--repo` arguments; gh selects the working directory's repository without them. */
const repoArgs = (repo: string | undefined) =>
  repo === undefined ? [] : ["--repo", repo];

/** Input for {@link list}. */
export interface ListInput {
  readonly repo?: string;
  /** At most this many caches, 30 by default. */
  readonly limit?: number;
  /** Only caches whose key starts with this prefix. */
  readonly key?: string;
  /** `refs/heads/<branch>` or `refs/pull/<number>/merge`. */
  readonly ref?: string;
  /** `last_accessed_at` by default. */
  readonly sort?: "created_at" | "last_accessed_at" | "size_in_bytes";
  /** `desc` by default. */
  readonly order?: "asc" | "desc";
}

/** List a repository's Actions caches. */
export const list = Effect.fn("Cache.list")(function* (
  input: ListInput = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "cache",
      "list",
      ...repoArgs(input.repo),
      ...(input.limit === undefined ? [] : ["--limit", String(input.limit)]),
      ...(input.key === undefined ? [] : ["--key", input.key]),
      ...(input.ref === undefined ? [] : ["--ref", input.ref]),
      ...(input.sort === undefined ? [] : ["--sort", input.sort]),
      ...(input.order === undefined ? [] : ["--order", input.order]),
      "--json",
      Object.keys(Item.fields).join(","),
    ],
    Schema.Array(Item),
    options,
  );
});

/** Input for {@link remove}: one cache by ID, one by key, or every cache. */
export type RemoveInput =
  | { readonly repo?: string; readonly id: number }
  | {
      readonly repo?: string;
      readonly key: string;
      /** Only the cache with this key on this ref. */
      readonly ref?: string;
    }
  | {
      readonly repo?: string;
      readonly all: true;
      /** Only the caches of this ref. */
      readonly ref?: string;
      /** Succeed instead of failing when there are no caches. */
      readonly succeedOnNoCaches?: boolean;
    };

/** Delete a cache by ID or key, or all caches with `all`. */
export const remove = Effect.fn("Cache.remove")(function* (
  input: RemoveInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  const base = ["cache", "delete", ...repoArgs(input.repo)];

  const args =
    "id" in input
      ? [...base, "--", String(input.id)]
      : "key" in input
        ? [
            ...base,
            ...(input.ref === undefined ? [] : ["--ref", input.ref]),
            "--",
            input.key,
          ]
        : [
            ...base,
            "--all",
            ...(input.ref === undefined ? [] : ["--ref", input.ref]),
            ...(input.succeedOnNoCaches ? ["--succeed-on-no-caches"] : []),
          ];

  yield* gh.execute(args, options);
});
