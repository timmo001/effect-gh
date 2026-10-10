import { Effect } from "effect";
import { Gh, type GhOptions } from "./gh.js";

/** The installed gh version, such as `2.81.0`. Fails when gh cannot run. */
export const version = Effect.fn("Cli.version")(function* (
  options?: GhOptions,
) {
  const gh = yield* Gh;
  const output = (yield* gh.execute(["--version"], options)).stdout;

  return /gh version (\S+)/.exec(output)?.[1] ?? output.trim();
});
