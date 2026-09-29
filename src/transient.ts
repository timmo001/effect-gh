import { Effect, Match, Option, Schedule } from "effect";
import { GhCommandError, type GhError } from "./errors.js";

const statusPattern = /\b(?:HTTP|status(?: code)?)\s*(\d{3})\b/i;

const transientStatuses: ReadonlySet<number> = new Set([
  408, 429, 500, 502, 503, 504,
]);

const networkPattern =
  /connection reset|could not resolve host|error connecting to|no such host|temporary failure in name resolution|network is unreachable|no route to host|temporarily unavailable|tls handshake|i\/o timeout|timed out|context deadline exceeded/i;

/** HTTP status reported by a failed `gh` command, such as `gh: Not Found (HTTP 404)`. */
export const httpStatus = (error: GhError): Option.Option<number> => {
  if (!(error instanceof GhCommandError)) return Option.none();
  const match = statusPattern.exec(error.stderr);

  return match?.[1] === undefined
    ? Option.none()
    : Option.some(Number(match[1]));
};

/** Whether a `gh` command failed because of a primary or secondary GitHub rate limit. */
export const isRateLimited = (error: GhError): boolean =>
  error instanceof GhCommandError &&
  (Option.contains(httpStatus(error), 429) ||
    /rate limit/i.test(`${error.stderr}\n${error.stdout}`));

/**
 * Whether a failure is worth retrying: timeouts, rate limits, HTTP 408, 429 and
 * 5xx gateway statuses, and network failures reported by `gh`.
 */
export const isTransient = (error: GhError): boolean =>
  Match.value(error).pipe(
    Match.tags({
      GhTimeoutError: () => true,
      GhCommandError: (error) =>
        isRateLimited(error) ||
        Option.exists(httpStatus(error), (status) =>
          transientStatuses.has(status),
        ) ||
        networkPattern.test(error.stderr),
    }),
    Match.orElse(() => false),
  );

/** Jittered exponential backoff from 250 milliseconds, capped at 10 seconds. */
export const defaultRetrySchedule = Schedule.min([
  Schedule.exponential("250 millis"),
  Schedule.spaced("10 seconds"),
]).pipe(Schedule.jittered);

/** Options for {@link retryTransient}. */
export interface RetryTransientOptions<B = unknown, ES = never, R = never> {
  /** Delay policy between attempts. Defaults to {@link defaultRetrySchedule}. */
  readonly schedule?: Schedule.Schedule<B, GhError, ES, R>;
  /** Retries after the first attempt. Defaults to 3. */
  readonly times?: number;
}

/**
 * Retries failures matched by {@link isTransient}. Apply only to idempotent
 * reads: a mutation can take effect even when the command reports a failure.
 */
export const retryTransient =
  <B = unknown, ES = never, R1 = never>(
    options: RetryTransientOptions<B, ES, R1> = {},
  ) =>
  <A, E extends GhError, R>(
    self: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ES, R | R1> =>
    Effect.retry(self, {
      while: isTransient,
      schedule: options.schedule ?? defaultRetrySchedule,
      times: options.times ?? 3,
    });
