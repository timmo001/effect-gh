import { Effect, Schema } from "effect";
import type * as Api from "./api.js";
import { GhInvalidOptionsError } from "./errors.js";
import type { GhOptions } from "./gh.js";
import type * as Graphql from "./graphql.js";

export const positiveInteger = Schema.Int.check(Schema.isGreaterThan(0));

/** [HOST/]OWNER/REPO, refusing option-like and empty values. */
export const repository = Schema.String.check(
  Schema.isPattern(
    /^(?:[a-zA-Z0-9.-]+(?::[0-9]+)?\/)?[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/,
  ),
);

export const decodeOptions = Effect.fn("decodeOptions")(function* <
  S extends Schema.Constraint,
>(schema: S, input: S["Type"]) {
  return yield* Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((cause) => new GhInvalidOptionsError({ cause })),
  );
});

/** A decoded [HOST/]OWNER/REPO split into its parts. */
export interface RepositoryParts {
  readonly owner: string;
  readonly name: string;
  readonly hostname?: string;
}

export const splitRepository = (repo: string): RepositoryParts => {
  const parts = repo.split("/");
  const [owner = "", name = ""] = parts.slice(-2);
  const hostname = parts.length === 3 ? parts[0] : undefined;

  return hostname === undefined ? { owner, name } : { owner, name, hostname };
};

/** GraphQL query options for an optional Enterprise Server host. */
export const onHost = (
  options: Omit<GhOptions, "stdin"> | undefined,
  hostname: string | undefined,
): Graphql.QueryOptions =>
  hostname === undefined ? { ...options } : { ...options, hostname };

/** A REST request for an optional Enterprise Server host and gh overrides. */
export const restRequest = (
  request: Api.Request,
  hostname: string | undefined,
  options: Omit<GhOptions, "stdin"> | undefined,
): Api.Request => {
  const hosted = hostname === undefined ? request : { ...request, hostname };

  return options === undefined ? hosted : { ...hosted, options };
};

export const Author = Schema.NullOr(Schema.Struct({ login: Schema.String }));

export const PageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
});

export const connection = <S extends Schema.Top>(node: S) =>
  Schema.Struct({ nodes: Schema.Array(node), pageInfo: PageInfo });

export interface Page<A> {
  readonly nodes: ReadonlyArray<A>;
  readonly pageInfo: typeof PageInfo.Type;
}

/** Follow a GraphQL connection's cursor until it ends or `limit` nodes are collected. */
export const collectPages = Effect.fnUntraced(function* <A, E, R>(
  page: (after: string | null) => Effect.Effect<Page<A>, E, R>,
  limit = Number.POSITIVE_INFINITY,
) {
  const items: Array<A> = [];
  let after: string | null = null;

  while (true) {
    const result: Page<A> = yield* page(after);
    items.push(...result.nodes);

    if (
      !result.pageInfo.hasNextPage ||
      result.pageInfo.endCursor === null ||
      items.length >= limit
    )
      return items.slice(0, limit);

    after = result.pageInfo.endCursor;
  }
});
