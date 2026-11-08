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

/** Input for {@link login}. */
export interface LoginInput {
  /** Personal access token, sent to gh on stdin and never as an argument. */
  readonly token: string;
  readonly hostname?: string;
  /** Protocol for git operations on the host. */
  readonly gitProtocol?: "ssh" | "https";
  /** Store the token in plain text instead of the credential store. */
  readonly insecureStorage?: boolean;
  /** Skip the SSH key generate and upload step. */
  readonly skipSshKey?: boolean;
}

/** Log in to a host with a token read from stdin (`--with-token`). */
export const login = Effect.fn("Auth.login")(function* (
  input: LoginInput,
  options?: Omit<GhOptions, "stdin">,
) {
  const gh = yield* Gh;
  const args = ["auth", "login", "--with-token", ...hostArgs(input.hostname)];

  if (input.gitProtocol !== undefined)
    args.push("--git-protocol", input.gitProtocol);

  if (input.insecureStorage) args.push("--insecure-storage");

  if (input.skipSshKey) args.push("--skip-ssh-key");
  yield* gh.execute(args, { ...options, stdin: input.token });
});

/** Remove the stored credentials of an account. The token is not revoked. */
export const logout = Effect.fn("Auth.logout")(function* (
  input: { readonly hostname?: string; readonly user?: string },
  options?: GhOptions,
) {
  const gh = yield* Gh;
  const args = ["auth", "logout", ...hostArgs(input.hostname)];

  if (input.user !== undefined) args.push("--user", input.user);
  yield* gh.execute(args, options);
});

/** Input for {@link refresh}. */
export interface RefreshInput {
  readonly hostname?: string;
  /** Scopes to add. */
  readonly scopes?: ReadonlyArray<string>;
  /** Scopes to remove. */
  readonly removeScopes?: ReadonlyArray<string>;
  /** Reset to the default minimum scopes. */
  readonly resetScopes?: boolean;
}

/**
 * Add, remove or reset the scopes of the active account's credentials. gh
 * authenticates in a browser, so this runs on the terminal.
 */
export const refresh = Effect.fn("Auth.refresh")(function* (
  input: RefreshInput = {},
  options?: Omit<GhOptions, "stdin" | "maxOutputBytes">,
) {
  const gh = yield* Gh;
  const args = ["auth", "refresh", ...hostArgs(input.hostname)];

  if (input.scopes !== undefined && input.scopes.length > 0)
    args.push("--scopes", input.scopes.join(","));

  if (input.removeScopes !== undefined && input.removeScopes.length > 0)
    args.push("--remove-scopes", input.removeScopes.join(","));

  if (input.resetScopes) args.push("--reset-scopes");
  yield* gh.interactive(args, options);
});

/** Configure git to use gh as its credential helper, for one host or every authenticated one. */
export const setupGit = Effect.fn("Auth.setupGit")(function* (
  input: {
    readonly hostname?: string;
    /** Set up a host gh does not know. Needs `hostname`. */
    readonly force?: boolean;
  } = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;
  const args = ["auth", "setup-git", ...hostArgs(input.hostname)];

  if (input.force) args.push("--force");
  yield* gh.execute(args, options);
});

/** Switch the active account for a host. */
export const switchAccount = Effect.fn("Auth.switchAccount")(function* (
  input: { readonly hostname?: string; readonly user?: string },
  options?: GhOptions,
) {
  const gh = yield* Gh;
  const args = ["auth", "switch", ...hostArgs(input.hostname)];

  if (input.user !== undefined) args.push("--user", input.user);
  yield* gh.execute(args, options);
});
