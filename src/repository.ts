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
