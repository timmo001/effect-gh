import { Cache, Duration, Effect, Exit, Schema } from "effect";
import * as Api from "./api.js";
import type { GhError } from "./errors.js";
import type { Gh, GhOptions } from "./gh.js";

export const Resource = Schema.Struct({
  limit: Schema.Int,
  used: Schema.Int,
  remaining: Schema.Int,
  /** Reset time in epoch seconds. */
  reset: Schema.Int,
});

export interface Resource extends Schema.Schema.Type<typeof Resource> {}

export type ResourceName = "core" | "graphql" | "search";

const response = Schema.Struct({
  resources: Schema.Struct({
    core: Resource,
    graphql: Resource,
    search: Resource,
  }),
});

/** Reads one REST, GraphQL or search quota from `gh api rate_limit`, which does not count against the quota. */
export const get = Effect.fn("RateLimit.get")(function* (
  resource: ResourceName = "core",
  options?: Omit<GhOptions, "stdin">,
): Effect.fn.Return<Resource, GhError, Gh> {
  const { resources } = yield* Api.json(
    { endpoint: "rate_limit", method: "GET", ...(options && { options }) },
    response,
  );

  return resources[resource];
});

/**
 * Builds a cache of {@link get} reads keyed by resource. Successful reads live
 * for `timeToLive`; failed reads are not kept. Use `Cache.get` to read and
 * `Cache.invalidate` after a rate-limited failure.
 */
export const cached = (
  timeToLive: Duration.Input,
  options?: Omit<GhOptions, "stdin">,
): Effect.Effect<Cache.Cache<ResourceName, Resource, GhError>, never, Gh> =>
  Cache.makeWith((resource: ResourceName) => get(resource, options), {
    capacity: 3,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? timeToLive : Duration.zero),
  });
