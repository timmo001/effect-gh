import { Cache, Clock, Duration, Effect, Exit, Option, Schema } from "effect";
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

/** The quota is spent and resets later than the guard is willing to wait. */
export class RateLimitExhausted extends Schema.TaggedError<RateLimitExhausted>()(
  "RateLimitExhausted",
  {
    resource: Schema.Literals(["core", "graphql", "search"]),
    /** Reset time in epoch seconds. */
    reset: Schema.Int,
  },
) {}

/** Options for {@link guard}. */
export interface GuardOptions {
  readonly resource?: ResourceName;
  /** Wait or fail once remaining requests drop to this. Defaults to 0. */
  readonly minRemaining?: number;
  /** Longest wait for a reset before failing. Defaults to 60 seconds. */
  readonly maxWait?: Duration.Input;
}

/**
 * Check a cached quota before a request. When it is spent, sleep until the
 * reset if that is within `maxWait`, otherwise fail with RateLimitExhausted.
 * A failed quota read lets the request go ahead.
 */
export const guard = Effect.fn("RateLimit.guard")(function* (
  cache: Cache.Cache<ResourceName, Resource, GhError>,
  options: GuardOptions = {},
) {
  const resource = options.resource ?? "core";
  const snapshot = yield* Cache.get(cache, resource).pipe(Effect.option);

  if (
    Option.isNone(snapshot) ||
    snapshot.value.remaining > (options.minRemaining ?? 0)
  )
    return;

  const now = yield* Clock.currentTimeMillis;
  const wait = Math.max(0, snapshot.value.reset * 1000 - now);

  if (wait > Duration.toMillis(options.maxWait ?? "60 seconds"))
    return yield* new RateLimitExhausted({
      resource,
      reset: snapshot.value.reset,
    });

  yield* Effect.sleep(Duration.millis(wait + 1000));
  yield* Cache.invalidate(cache, resource);
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
