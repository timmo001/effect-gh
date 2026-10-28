import {
  Kind,
  parse,
  type FragmentDefinitionNode,
  type SelectionSetNode,
} from "graphql/language";
import { Effect, Schema } from "effect";
import * as Api from "./api.js";
import { GhDecodeError, type GhError } from "./errors.js";
import type { Gh, GhOptions } from "./gh.js";

/** One entry of a GraphQL response's `errors`. */
export const ErrorEntry = Schema.Struct({
  message: Schema.String,
  type: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(
    Schema.Array(Schema.Union([Schema.String, Schema.Int])),
  ),
});

export interface ErrorEntry extends Schema.Schema.Type<typeof ErrorEntry> {}

/** The response carried GraphQL `errors`, such as NOT_FOUND or a schema mismatch in the document. */
export class ResponseError extends Schema.TaggedError<ResponseError>()(
  "GraphqlResponseError",
  { errors: Schema.Array(ErrorEntry) },
) {}

/** The document is not valid GraphQL syntax. */
export class ParseError extends Schema.TaggedError<ParseError>()(
  "GraphqlParseError",
  { message: Schema.String },
) {}

export type Variables = { readonly [name: string]: Schema.Json };

/** Gh overrides for {@link query}, plus the GitHub host for Enterprise Server. */
export interface QueryOptions extends Omit<GhOptions, "stdin"> {
  readonly hostname?: string;
}

const envelope = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.optionalKey(Schema.Unknown),
    errors: Schema.optionalKey(Schema.Array(ErrorEntry)),
  }),
);

/**
 * Run a query or mutation through `gh api graphql` and decode `data` with the
 * schema. A response with `errors` fails with ResponseError, even when gh
 * exits non-zero. Never retries.
 */
export const query = Effect.fn("Graphql.query")(function* <
  S extends Schema.Constraint,
>(
  document: string,
  variables: Variables | undefined,
  schema: S,
  options: QueryOptions = {},
): Effect.fn.Return<
  S["Type"],
  GhError | ResponseError,
  Gh | S["DecodingServices"]
> {
  const { hostname, ...gh } = options;

  const request: Api.Request = {
    endpoint: "graphql",
    method: "POST",
    body: { query: document, variables: variables ?? {} },
    options: gh,
  };

  const result = yield* Api.raw(
    hostname === undefined ? request : { ...request, hostname },
  ).pipe(
    Effect.map((output) => ({ stdout: output.stdout, failure: undefined })),
    // gh exits 1 on GraphQL errors but still prints the response body.
    Effect.catchTag("GhCommandError", (error) =>
      error.exitCode === 1 && !error.stdoutTruncated
        ? Effect.succeed({ stdout: error.stdout, failure: error })
        : Effect.fail(error),
    ),
  );

  const response = yield* Schema.decodeEffect(envelope)(result.stdout).pipe(
    Effect.mapError((cause) => result.failure ?? new GhDecodeError({ cause })),
  );

  if (response.errors !== undefined && response.errors.length > 0)
    return yield* new ResponseError({ errors: response.errors });

  if (result.failure !== undefined) return yield* result.failure;

  return yield* Schema.decodeUnknownEffect(schema)(response.data).pipe(
    Effect.mapError((cause) => new GhDecodeError({ cause })),
  );
});

export const OperationKind = Schema.Literals([
  "query",
  "mutation",
  "subscription",
]);

export type OperationKind = typeof OperationKind.Type;

export const Operation = Schema.Struct({
  kind: OperationKind,
  /** The operation's name, or null when it is anonymous. */
  name: Schema.NullOr(Schema.String),
  /** Top-level field names, not aliases, with fragments expanded. */
  fields: Schema.Array(Schema.String),
});

export interface Operation extends Schema.Schema.Type<typeof Operation> {}

const topLevelFields = (
  selectionSet: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  visited: ReadonlySet<string>,
): Array<string> =>
  selectionSet.selections.flatMap((selection) => {
    switch (selection.kind) {
      case Kind.FIELD:
        return [selection.name.value];
      case Kind.INLINE_FRAGMENT:
        return topLevelFields(selection.selectionSet, fragments, visited);
      case Kind.FRAGMENT_SPREAD: {
        const name = selection.name.value;
        const fragment = fragments.get(name);

        return fragment === undefined || visited.has(name)
          ? []
          : topLevelFields(
              fragment.selectionSet,
              fragments,
              new Set([...visited, name]),
            );
      }
    }
  });

/**
 * Parse a document and list each operation's kind and top-level fields, so a
 * caller can tell reads from writes before running it. Fails with ParseError
 * on invalid syntax; it does not validate against GitHub's schema.
 */
export const operations = Effect.fn("Graphql.operations")(function* (
  document: string,
) {
  const parsed = yield* Effect.try({
    try: () => parse(document),
    catch: (cause) =>
      new ParseError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

  const fragments = new Map<string, FragmentDefinitionNode>();

  for (const definition of parsed.definitions)
    if (definition.kind === Kind.FRAGMENT_DEFINITION)
      fragments.set(definition.name.value, definition);

  const result: Array<Operation> = [];

  for (const definition of parsed.definitions)
    if (definition.kind === Kind.OPERATION_DEFINITION)
      result.push({
        kind: definition.operation,
        name: definition.name?.value ?? null,
        fields: [
          ...new Set(
            topLevelFields(definition.selectionSet, fragments, new Set()),
          ),
        ],
      });

  return result;
});
