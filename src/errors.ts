import { Schema } from "effect";

export class GhCommandError extends Schema.TaggedError<GhCommandError>()(
  "GhCommandError",
  {
    executable: Schema.String,
    exitCode: Schema.Int,
    stdout: Schema.String,
    stdoutTruncated: Schema.Boolean,
    stderr: Schema.String,
    stderrTruncated: Schema.Boolean,
  },
) {}

export class GhPlatformError extends Schema.TaggedError<GhPlatformError>()(
  "GhPlatformError",
  { executable: Schema.String, cause: Schema.Defect() },
) {}

export class GhTimeoutError extends Schema.TaggedError<GhTimeoutError>()(
  "GhTimeoutError",
  { executable: Schema.String, timeoutMs: Schema.Finite },
) {}

export class GhDecodeError extends Schema.TaggedError<GhDecodeError>()(
  "GhDecodeError",
  { cause: Schema.Defect() },
) {}

/** Stdout grew past `GhOptions.maxOutputBytes`; the command was stopped. */
export class GhOutputLimitError extends Schema.TaggedError<GhOutputLimitError>()(
  "GhOutputLimitError",
  { executable: Schema.String, limitBytes: Schema.Int },
) {}

/** Operation options failed schema validation before any command was spawned. */
export class GhInvalidOptionsError extends Schema.TaggedError<GhInvalidOptionsError>()(
  "GhInvalidOptionsError",
  { cause: Schema.Defect() },
) {}

export type GhError =
  | GhCommandError
  | GhPlatformError
  | GhTimeoutError
  | GhDecodeError
  | GhOutputLimitError
  | GhInvalidOptionsError;
