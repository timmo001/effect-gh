import { Effect, Option, Stream } from "effect";
import * as Api from "./api.js";
import { Gh, type GhOptions } from "./gh.js";

const hostArgs = (hostname: string | undefined) =>
  hostname === undefined ? [] : ["--hostname", hostname];

/** Whether gh has a usable login, for one host or for every configured host. */
export const status = Effect.fn("Auth.status")(function* (
  hostname?: string,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh
    .execute(["auth", "status", ...hostArgs(hostname)], options)
    .pipe(
      Effect.as(true),
      Effect.catchTag("GhCommandError", () => Effect.succeed(false)),
    );
});

/**
 * Whether gh can print a token. The output is drained and never kept, so the
 * token cannot reach logs, reports or errors.
 */
export const hasToken = Effect.fn("Auth.hasToken")(function* (
  hostname?: string,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh
    .stream(["auth", "token", ...hostArgs(hostname)], options)
    .pipe(
      Stream.runDrain,
      Effect.as(true),
      Effect.catchTag("GhCommandError", () => Effect.succeed(false)),
    );
});

/**
 * Classic OAuth scopes of the active token, read from the `x-oauth-scopes`
 * header without reading the token. None for fine-grained and installation
 * tokens, which do not report classic scopes.
 */
export const scopes = Effect.fn("Auth.scopes")(function* (
  hostname = "github.com",
  options?: Omit<GhOptions, "stdin">,
) {
  const headers = yield* Api.headers({
    endpoint: "user",
    method: "HEAD",
    hostname,
    ...(options && { options }),
  });

  return Option.fromNullishOr(headers["x-oauth-scopes"]).pipe(
    Option.map((value) =>
      value
        .split(",")
        .map((scope) => scope.trim())
        .filter((scope) => scope !== ""),
    ),
  );
});
