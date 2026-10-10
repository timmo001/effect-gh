import { Effect, Schema } from "effect";
import { Gh, type GhOptions } from "./gh.js";

export const CodeResult = Schema.Struct({
  path: Schema.String,
  url: Schema.String,
  repository: Schema.Struct({ nameWithOwner: Schema.String }),
});

export interface CodeResult extends Schema.Schema.Type<typeof CodeResult> {}

/** Input for {@link code}. */
export interface CodeInput {
  readonly query: string;
  readonly owner?: string;
  readonly repo?: string;
  readonly filename?: string;
  /** Defaults to gh's 30; the search API caps results at 1000. */
  readonly limit?: number;
}

/** Search code with GitHub's code search. */
export const code = Effect.fn("Search.code")(function* (
  input: CodeInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;
  const args = ["search", "code", "--json", "path,url,repository"];

  if (input.owner !== undefined) args.push("--owner", input.owner);

  if (input.repo !== undefined) args.push("--repo", input.repo);

  if (input.filename !== undefined) args.push("--filename", input.filename);

  if (input.limit !== undefined) args.push("--limit", String(input.limit));
  args.push("--", input.query);

  return yield* gh.json(args, Schema.Array(CodeResult), options);
});
