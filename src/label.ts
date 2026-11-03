import { Effect, Schema } from "effect";
import { Gh, type GhOptions } from "./gh.js";

/** Input for {@link create}. */
export interface CreateInput {
  readonly repo: string;
  readonly name: string;
  /** Hex colour without `#`. */
  readonly color?: string;
  readonly description?: string;
  /** Update the label instead of failing when it already exists. */
  readonly force?: boolean;
}

/** Create a label, or update it with `force`. */
export const create = Effect.fn("Label.create")(function* (
  input: CreateInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;
  const args = ["label", "create", input.name, "--repo", input.repo];

  if (input.color !== undefined) args.push("--color", input.color);

  if (input.description !== undefined)
    args.push("--description", input.description);

  if (input.force) args.push("--force");
  yield* gh.execute(args, options);
});

/** Delete a label without prompting. */
export const remove = Effect.fn("Label.remove")(function* (
  input: { readonly repo: string; readonly name: string },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    ["label", "delete", input.name, "--repo", input.repo, "--yes"],
    options,
  );
});

/** A label as `gh label list --json name,color,description` returns it. */
export const Label = Schema.Struct({
  name: Schema.String,
  color: Schema.String,
  description: Schema.String,
});

export interface Label extends Schema.Schema.Type<typeof Label> {}

/** Every label on a repository, up to `limit` (1000 by default). */
export const list = Effect.fn("Label.list")(function* (
  input: {
    readonly repo: string;
    readonly limit?: number;
    /** Only labels whose name or description matches, best match first. */
    readonly search?: string;
  },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  const args = [
    "label",
    "list",
    "--repo",
    input.repo,
    "--limit",
    String(input.limit ?? 1000),
    "--json",
    "name,color,description",
  ];

  if (input.search !== undefined) args.push("--search", input.search);

  return yield* gh.json(args, Schema.Array(Label), options);
});

/** Input for {@link edit}. */
export interface EditInput {
  readonly repo: string;
  /** The label's current name. */
  readonly name: string;
  /** Rename the label, keeping it on its issues and pull requests. */
  readonly newName?: string;
  /** Hex colour without `#`. */
  readonly color?: string;
  readonly description?: string;
}

/** Change a label's name, colour or description in place. */
export const edit = Effect.fn("Label.edit")(function* (
  input: EditInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;
  const args = ["label", "edit", input.name, "--repo", input.repo];

  if (input.newName !== undefined) args.push("--name", input.newName);

  if (input.color !== undefined) args.push("--color", input.color);

  if (input.description !== undefined)
    args.push("--description", input.description);

  yield* gh.execute(args, options);
});

/**
 * Copy every label from `source` to `repo`. Existing labels are skipped, or
 * overwritten with `force`; labels only in `repo` are left alone.
 */
export const clone = Effect.fn("Label.clone")(function* (
  input: {
    readonly repo: string;
    readonly source: string;
    readonly force?: boolean;
  },
  options?: GhOptions,
) {
  const gh = yield* Gh;
  const args = ["label", "clone", input.source, "--repo", input.repo];

  if (input.force) args.push("--force");
  yield* gh.execute(args, options);
});
