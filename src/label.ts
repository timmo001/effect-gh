import { Effect } from "effect";
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
