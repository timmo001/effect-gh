import { Effect } from "effect";
import { Gh, type GhOptions } from "./gh.js";

/** The logins of your organizations, up to `limit` (30 by default). gh prints one per line. */
export const list = Effect.fn("Org.list")(function* (
  input: { readonly limit?: number } = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;

  const output = yield* gh.execute(
    ["org", "list", "--limit", String(input.limit ?? 30)],
    options,
  );

  return output.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
});
