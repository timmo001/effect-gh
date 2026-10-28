import { Effect, Schema } from "effect";
import * as Api from "./api.js";
import type { GhOptions } from "./gh.js";
import {
  Author,
  decodeOptions,
  positiveInteger,
  repository,
  restRequest,
  splitRepository,
} from "./internal.js";

/** A pull request or issue conversation comment, or a review comment. */
export const Comment = Schema.Struct({
  id: Schema.Int,
  nodeId: Schema.String,
  author: Author,
  body: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  url: Schema.String,
});

export interface Comment extends Schema.Schema.Type<typeof Comment> {}

const RestComment = Schema.Struct({
  id: Schema.Int,
  node_id: Schema.String,
  user: Author,
  body: Schema.optionalKey(Schema.NullOr(Schema.String)),
  created_at: Schema.String,
  updated_at: Schema.String,
  html_url: Schema.String,
});

const fromRest = (comment: typeof RestComment.Type): Comment => ({
  id: comment.id,
  nodeId: comment.node_id,
  author: comment.user,
  body: comment.body ?? "",
  createdAt: comment.created_at,
  updatedAt: comment.updated_at,
  url: comment.html_url,
});

const listOptions = Schema.Struct({
  repo: repository,
  /** Pull request or issue number; both share the issue comments endpoint. */
  number: positiveInteger,
});

export interface ListOptions extends Schema.Schema.Type<typeof listOptions> {}

/** Every conversation comment on a pull request or issue, oldest first. Excludes review comments. */
export const list = Effect.fn("Comment.list")(function* (
  input: ListOptions,
  options?: Omit<GhOptions, "stdin">,
) {
  const query = yield* decodeOptions(listOptions, input);
  const { owner, name, hostname } = splitRepository(query.repo);

  const request: Api.PageRequest = {
    endpoint: `repos/${owner}/${name}/issues/${query.number}/comments`,
    method: "GET",
    query: { per_page: 100 },
  };

  const hosted = hostname === undefined ? request : { ...request, hostname };

  const pages = yield* Api.pages(
    options === undefined ? hosted : { ...hosted, options },
    Schema.Array(RestComment),
  );

  return pages.flat().map(fromRest);
});

const targetOptions = Schema.Struct({
  repo: repository,
  /** The comment's numeric REST ID. */
  id: positiveInteger,
  /** `issue` for pull request and issue conversation comments (default), `review` for inline review comments. */
  kind: Schema.optionalKey(Schema.Literals(["issue", "review"])),
});

export interface TargetOptions extends Schema.Schema.Type<
  typeof targetOptions
> {}

const editOptions = Schema.Struct({
  ...targetOptions.fields,
  body: Schema.NonEmptyString,
});

export interface EditOptions extends Schema.Schema.Type<typeof editOptions> {}

const commentRequest = (
  query: TargetOptions,
  method: "PATCH" | "DELETE",
  options: Omit<GhOptions, "stdin"> | undefined,
  body?: string,
) => {
  const { owner, name, hostname } = splitRepository(query.repo);
  const scope = query.kind === "review" ? "pulls" : "issues";
  const endpoint = `repos/${owner}/${name}/${scope}/comments/${query.id}`;

  return restRequest(
    body === undefined
      ? { endpoint, method }
      : { endpoint, method, body: { body } },
    hostname,
    options,
  );
};

/** Replace a comment's body and return the updated comment. Never retries. */
export const edit = Effect.fn("Comment.edit")(function* (
  input: EditOptions,
  options?: Omit<GhOptions, "stdin">,
) {
  const query = yield* decodeOptions(editOptions, input);

  return fromRest(
    yield* Api.json(
      commentRequest(query, "PATCH", options, query.body),
      RestComment,
    ),
  );
});

/** Delete a comment. Never retries. */
export const remove = Effect.fn("Comment.remove")(function* (
  input: TargetOptions,
  options?: Omit<GhOptions, "stdin">,
) {
  const query = yield* decodeOptions(targetOptions, input);

  yield* Api.empty(commentRequest(query, "DELETE", options));
});
