import { Schema } from "effect";

export class GhCommandError extends Schema.TaggedError<GhCommandError>()(
  "GhCommandError",
  {
    executable: Schema.String,
    exitCode: Schema.Int,
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

export type GhError =
  GhCommandError | GhPlatformError | GhTimeoutError | GhDecodeError;
