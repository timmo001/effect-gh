import { Data, Effect, Schema } from "effect";
import { GhDecodeError, type GhError } from "./errors.js";
import { Gh, type GhOptions, type GhOutput } from "./gh.js";

export const Method = Schema.Literals([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "TRACE",
  "CONNECT",
]);

export type Method = typeof Method.Type;

const queryValue = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]);

const requestSchema = Schema.Struct({
  endpoint: Schema.NonEmptyString,
  method: Method,
  hostname: Schema.optionalKey(Schema.NonEmptyString),
  query: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Union([queryValue, Schema.Array(queryValue)]),
    ),
  ),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  body: Schema.optionalKey(Schema.Json),
});

export interface Request extends Schema.Schema.Type<typeof requestSchema> {
  /** Gh overrides. Stdin is owned by body; bodyless calls clear any layer stdin. */
  readonly options?: Omit<GhOptions, "stdin">;
}

export interface PageRequest extends Omit<Request, "method" | "body"> {
  readonly method: "GET";
  readonly body?: never;
}

const pageRequestSchema = Schema.Struct({
  ...requestSchema.fields,
  endpoint: Schema.NonEmptyString.check(
    Schema.isPattern(/^(?!\/?graphql(?:[?#]|$))/),
  ),
  method: Schema.Literal("GET"),
  body: Schema.optionalKey(Schema.Never),
});

const prepare = Effect.fn("Api.prepare")(function* (request: Request) {
  const input = yield* Schema.decodeEffect(requestSchema)(request).pipe(
    Effect.mapError((cause) => new GhDecodeError({ cause })),
  );

  const endpoint = yield* Effect.try({
    try: () => {
      const query: Array<string> = [];

      for (const [key, value] of Object.entries(input.query ?? {})) {
        for (const item of Array.isArray(value) ? value : [value]) {
          query.push(
            `${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`,
          );
        }
      }

      if (query.length === 0) return input.endpoint;
      const fragmentIndex = input.endpoint.indexOf("#");

      const path =
        fragmentIndex === -1
          ? input.endpoint
          : input.endpoint.slice(0, fragmentIndex);

      const fragment =
        fragmentIndex === -1 ? "" : input.endpoint.slice(fragmentIndex);

      const separator = !path.includes("?")
        ? "?"
        : path.endsWith("?") || path.endsWith("&")
          ? ""
          : "&";

      return `${path}${separator}${query.join("&")}${fragment}`;
    },
    catch: (cause) => new GhDecodeError({ cause }),
  });

  const args = ["api", "--method", input.method];

  if (input.hostname !== undefined) args.push(`--hostname=${input.hostname}`);

  for (const [name, value] of Object.entries(input.headers ?? {})) {
    args.push(`--header=${name}: ${value}`);
  }

  let stdin: string | undefined;

  if (input.body !== undefined) {
    stdin = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(
      input.body,
    ).pipe(Effect.mapError((cause) => new GhDecodeError({ cause })));
    args.push("--input", "-");
  }

  return { args, endpoint, options: { ...request.options, stdin } };
});

/** Returns stdout, stderr and the CLI exit code, including empty or non-JSON responses verbatim. Needs gh 2.97.0 or later. Never retries. */
export const raw = Effect.fn("Api.raw")(function* (
  request: Request,
): Effect.fn.Return<GhOutput, GhError, Gh> {
  const command = yield* prepare(request);
  const gh = yield* Gh;

  return yield* gh.execute(
    // Piped gh refuses a non-JSON body carrying escape sequences without this.
    [...command.args, "--allow-escape-sequences", "--", command.endpoint],
    command.options,
  );
});

/** Runs a request whose response body is not needed, such as a 204 mutation. Never retries. */
export const empty = Effect.fn("Api.empty")(function* (
  request: Request,
): Effect.fn.Return<void, GhError, Gh> {
  yield* raw(request);
});

/** Returns the response body as text, for raw file contents and other non-JSON media types. Never retries. */
export const text = Effect.fn("Api.text")(function* (
  request: Request,
): Effect.fn.Return<string, GhError, Gh> {
  return (yield* raw(request)).stdout;
});

// Splits `gh api --include` output into its status, lower-cased headers and body.
const parseIncluded = (stdout: string) => {
  const blank = /\r?\n\r?\n/.exec(stdout);
  const head = blank ? stdout.slice(0, blank.index) : stdout;
  const [statusLine = "", ...lines] = head.split(/\r?\n/);
  const headers: Record<string, string> = {};

  for (const line of lines) {
    const separator = line.indexOf(":");

    if (separator > 0)
      headers[line.slice(0, separator).trim().toLowerCase()] = line
        .slice(separator + 1)
        .trim();
  }

  return {
    status: Number(/^HTTP\/\S+\s+(\d{3})\b/.exec(statusLine)?.[1] ?? 0),
    headers,
    body: blank ? stdout.slice(blank.index + blank[0].length) : "",
  };
};

/** Returns the response headers with lower-cased names. Use method HEAD to skip the body. Never retries. */
export const headers = Effect.fn("Api.headers")(function* (
  request: Request,
): Effect.fn.Return<Readonly<Record<string, string>>, GhError, Gh> {
  const command = yield* prepare(request);
  const gh = yield* Gh;

  const output = yield* gh.execute(
    [...command.args, "--include", "--", command.endpoint],
    command.options,
  );

  return parseIncluded(output.stdout).headers;
});

/** Cache validators from an earlier response, sent back as `If-None-Match` and `If-Modified-Since`. */
export interface Validators {
  readonly etag?: string;
  readonly lastModified?: string;
}

/** A conditional GET's outcome. Both carry the response headers with lower-cased names, such as `x-poll-interval`. */
export type Conditional<A> = Data.TaggedEnum<{
  Modified: {
    readonly value: A;
    /** Validators for the next request; empty when the response sent none. */
    readonly validators: Validators;
    readonly headers: Readonly<Record<string, string>>;
  };
  NotModified: { readonly headers: Readonly<Record<string, string>> };
}>;

interface ConditionalDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: Conditional<this["A"]>;
}

export const Conditional = Data.taggedEnum<ConditionalDefinition>();

/**
 * A REST GET that sends the validators from an earlier response. GitHub answers
 * 304 when nothing changed, which costs no primary rate limit. Decodes the body
 * only on a 200. Never retries.
 */
export const conditional = Effect.fn("Api.conditional")(function* <
  S extends Schema.Constraint,
>(
  request: Omit<PageRequest, "method">,
  schema: S,
  validators: Validators = {},
): Effect.fn.Return<
  Conditional<S["Type"]>,
  GhError,
  Gh | S["DecodingServices"]
> {
  const command = yield* prepare({
    ...request,
    method: "GET",
    headers: {
      ...request.headers,
      ...(validators.etag !== undefined && {
        "If-None-Match": validators.etag,
      }),
      ...(validators.lastModified !== undefined && {
        "If-Modified-Since": validators.lastModified,
      }),
    },
  });

  const gh = yield* Gh;

  // gh exits 1 on a 304, but still prints the status line and headers.
  const stdout = yield* gh
    .execute(
      [...command.args, "--include", "--", command.endpoint],
      command.options,
    )
    .pipe(
      Effect.map((output) => output.stdout),
      Effect.catchTag("GhCommandError", (error) =>
        parseIncluded(error.stdout).status === 304
          ? Effect.succeed(error.stdout)
          : Effect.fail(error),
      ),
    );

  const response = parseIncluded(stdout);

  if (response.status === 304)
    return Conditional.NotModified({ headers: response.headers });

  const value = yield* Schema.decodeEffect(Schema.fromJsonString(schema))(
    response.body,
  ).pipe(Effect.mapError((cause) => new GhDecodeError({ cause })));

  return Conditional.Modified({
    value,
    validators: {
      ...(response.headers.etag !== undefined && {
        etag: response.headers.etag,
      }),
      ...(response.headers["last-modified"] !== undefined && {
        lastModified: response.headers["last-modified"],
      }),
    },
    headers: response.headers,
  });
});

/** Decodes one JSON response. Encoding and decoding failures are GhDecodeError; requests never retry. */
export const json = Effect.fn("Api.json")(function* <
  S extends Schema.Constraint,
>(
  request: Request,
  schema: S,
): Effect.fn.Return<S["Type"], GhError, Gh | S["DecodingServices"]> {
  const command = yield* prepare(request);
  const gh = yield* Gh;

  return yield* gh.json(
    [...command.args, "--", command.endpoint],
    schema,
    command.options,
  );
});

/** Fetches REST GET pages with --paginate --slurp. The schema describes each page, preserving envelopes. Never retries. */
export const pages = Effect.fn("Api.pages")(function* <
  S extends Schema.Constraint,
>(
  request: PageRequest,
  schema: S,
): Effect.fn.Return<
  ReadonlyArray<S["Type"]>,
  GhError,
  Gh | S["DecodingServices"]
> {
  yield* Schema.decodeEffect(pageRequestSchema)(request).pipe(
    Effect.mapError((cause) => new GhDecodeError({ cause })),
  );
  const command = yield* prepare(request);
  const gh = yield* Gh;

  return yield* gh.json(
    [...command.args, "--paginate", "--slurp", "--", command.endpoint],
    Schema.Array(schema),
    command.options,
  );
});
