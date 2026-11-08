import { Effect } from "effect";
import { Gh, type GhOptions } from "./gh.js";

/** Input for {@link get}. */
export interface GetInput {
  /** Exclude these repositories, as `owner/name`. */
  readonly exclude?: ReadonlyArray<string>;
  /** Report status within one organization. */
  readonly org?: string;
}

/** Your GitHub status as gh's text report: assigned issues and pull requests, review requests, mentions and repository activity. gh has no JSON output for it. */
export const get = Effect.fn("Status.get")(function* (
  input: GetInput = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;
  const args = ["status"];

  if (input.exclude !== undefined && input.exclude.length > 0)
    args.push("--exclude", input.exclude.join(","));

  if (input.org !== undefined) args.push("--org", input.org);

  return (yield* gh.execute(args, options)).stdout;
});
