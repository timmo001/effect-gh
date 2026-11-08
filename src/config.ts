import { Effect, Schema } from "effect";
import { Gh, type GhOptions } from "./gh.js";

const hostArgs = (host: string | undefined) =>
  host === undefined ? [] : ["--host", host];

/** One setting as `gh config list` prints it. */
export const Entry = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
});

export interface Entry extends Schema.Schema.Type<typeof Entry> {}

/** Parse `gh config list`, which has no JSON output: one `key=value` line per setting. */
export const parseList = (output: string): ReadonlyArray<Entry> =>
  output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const index = line.indexOf("=");

      return Entry.make(
        index === -1
          ? { key: line.trim(), value: "" }
          : { key: line.slice(0, index), value: line.slice(index + 1) },
      );
    });

/** The value of a configuration key, for one host with `host`. */
export const get = Effect.fn("Config.get")(function* (
  input: { readonly key: string; readonly host?: string },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  const output = yield* gh.execute(
    ["config", "get", ...hostArgs(input.host), "--", input.key],
    options,
  );

  return output.stdout.replace(/\r?\n$/, "");
});

/** Set a configuration key, for one host with `host`. */
export const set = Effect.fn("Config.set")(function* (
  input: {
    readonly key: string;
    readonly value: string;
    readonly host?: string;
  },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    ["config", "set", ...hostArgs(input.host), "--", input.key, input.value],
    options,
  );
});

/** Every configuration key and value, for one host with `host`. */
export const list = Effect.fn("Config.list")(function* (
  input: { readonly host?: string } = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return parseList(
    (yield* gh.execute(["config", "list", ...hostArgs(input.host)], options))
      .stdout,
  );
});

/** Clear gh's cache. */
export const clearCache = Effect.fn("Config.clearCache")(function* (
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(["config", "clear-cache"], options);
});
