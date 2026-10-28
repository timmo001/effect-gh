import { Effect, Schema } from "effect";
import * as Api from "./api.js";
import { Gh, type GhOptions } from "./gh.js";
import { decodeOptions, restRequest } from "./internal.js";

/** The repository is private, so its attachments would 404 for everyone without access to it. */
export class PrivateRepositoryError extends Schema.TaggedError<PrivateRepositoryError>()(
  "AttachmentPrivateRepositoryError",
  { repository: Schema.String },
) {}

const contentTypes = new Map([
  ["apng", "image/apng"],
  ["avif", "image/avif"],
  ["gif", "image/gif"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["svg", "image/svg+xml"],
  ["webp", "image/webp"],
  ["mov", "video/quicktime"],
  ["mp4", "video/mp4"],
  ["webm", "video/webm"],
  ["csv", "text/csv"],
  ["log", "text/plain"],
  ["md", "text/markdown"],
  ["txt", "text/plain"],
  ["json", "application/json"],
  ["pdf", "application/pdf"],
  ["zip", "application/zip"],
  ["gz", "application/gzip"],
]);

const uploadOptions = Schema.Struct({
  /** OWNER/REPO on github.com that the post lives in, or a public fork of it. */
  repository: Schema.String.check(
    Schema.isPattern(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
  ),
  /** Local file to upload. */
  path: Schema.NonEmptyString.check(Schema.isPattern(/^(?!-$)/)),
  /** MIME type; inferred from the extension, falling back to application/octet-stream. */
  contentType: Schema.optionalKey(Schema.NonEmptyString),
});

export interface UploadOptions extends Schema.Schema.Type<
  typeof uploadOptions
> {}

/** The content type for a file name, from its extension. */
export const contentType = (path: string) =>
  contentTypes.get(path.split(".").at(-1)?.toLowerCase() ?? "") ??
  "application/octet-stream";

/**
 * Upload a file as a user attachment, the way the web editor does, and return
 * its URL for use in Markdown. Works for review bodies, inline comments and
 * discussions, and without write access to the repository. Refuses private
 * repositories. The asset 404s until it is used in a post. Never retries.
 */
export const upload = Effect.fn("Attachment.upload")(function* (
  input: UploadOptions,
  options?: Omit<GhOptions, "stdin">,
) {
  const query = yield* decodeOptions(uploadOptions, input);

  const repo = yield* Api.json(
    restRequest(
      { endpoint: `repos/${query.repository}`, method: "GET" },
      undefined,
      options,
    ),
    Schema.Struct({ id: Schema.Int, private: Schema.Boolean }),
  );

  if (repo.private)
    return yield* new PrivateRepositoryError({ repository: query.repository });

  const name = query.path.split(/[\\/]/).at(-1) ?? query.path;

  const url = `https://uploads.github.com/user-attachments/assets?${new URLSearchParams(
    {
      name,
      content_type: query.contentType ?? contentType(name),
      repository_id: String(repo.id),
    },
  ).toString()}`;

  const gh = yield* Gh;

  return (yield* gh.json(
    [
      "api",
      "--method",
      "POST",
      "--header=Content-Type: application/octet-stream",
      "--input",
      query.path,
      "--",
      url,
    ],
    Schema.Struct({ url: Schema.String }),
    { ...options, stdin: undefined },
  )).url;
});
