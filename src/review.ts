import { Effect, Schema } from "effect";
import * as Api from "./api.js";
import * as Graphql from "./graphql.js";
import type { GhOptions } from "./gh.js";
import {
  Author,
  collectPages,
  connection,
  decodeOptions,
  onHost,
  positiveInteger,
  repository,
  restRequest,
  splitRepository,
} from "./internal.js";

export const Review = Schema.Struct({
  id: Schema.String,
  databaseId: Schema.NullOr(Schema.Int),
  author: Author,
  state: Schema.String,
  body: Schema.String,
  /** Null while the review is pending. */
  submittedAt: Schema.NullOr(Schema.String),
  url: Schema.String,
});

export interface Review extends Schema.Schema.Type<typeof Review> {}

export const ThreadComment = Schema.Struct({
  id: Schema.String,
  databaseId: Schema.NullOr(Schema.Int),
  author: Author,
  body: Schema.String,
  createdAt: Schema.String,
  url: Schema.String,
});

export interface ThreadComment extends Schema.Schema.Type<
  typeof ThreadComment
> {}

export const Thread = Schema.Struct({
  id: Schema.String,
  isResolved: Schema.Boolean,
  isOutdated: Schema.Boolean,
  path: Schema.String,
  /** Null when the thread no longer maps to a line in the current diff. */
  line: Schema.NullOr(Schema.Int),
  startLine: Schema.NullOr(Schema.Int),
  diffSide: Schema.Literals(["LEFT", "RIGHT"]),
  /** The first 100 comments. */
  comments: Schema.Array(ThreadComment),
});

export interface Thread extends Schema.Schema.Type<typeof Thread> {}

const pullRequestOptions = Schema.Struct({
  repo: repository,
  number: positiveInteger,
});

export interface PullRequestOptions extends Schema.Schema.Type<
  typeof pullRequestOptions
> {}

const threadsOptions = Schema.Struct({
  ...pullRequestOptions.fields,
  unresolvedOnly: Schema.optionalKey(Schema.Boolean),
});

export interface ThreadsOptions extends Schema.Schema.Type<
  typeof threadsOptions
> {}

const reviewsDocument = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: 100, after: $after) {
        nodes { id databaseId author { login } state body submittedAt url }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const reviewsPage = Schema.Struct({
  repository: Schema.Struct({
    pullRequest: Schema.Struct({ reviews: connection(Review) }),
  }),
});

/** Every review on a pull request, with bodies, oldest first. */
export const list = Effect.fn("Review.list")(function* (
  input: PullRequestOptions,
  options?: Omit<GhOptions, "stdin">,
) {
  const query = yield* decodeOptions(pullRequestOptions, input);
  const { owner, name, hostname } = splitRepository(query.repo);

  return yield* collectPages((after) =>
    Graphql.query(
      reviewsDocument,
      { owner, name, number: query.number, after },
      reviewsPage,
      onHost(options, hostname),
    ).pipe(Effect.map((data) => data.repository.pullRequest.reviews)),
  );
});

const threadsDocument = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        nodes {
          id isResolved isOutdated path line startLine diffSide
          comments(first: 100) {
            nodes { id databaseId author { login } body createdAt url }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const threadsPage = Schema.Struct({
  repository: Schema.Struct({
    pullRequest: Schema.Struct({
      reviewThreads: connection(
        Schema.Struct({
          ...Thread.fields,
          comments: Schema.Struct({ nodes: Schema.Array(ThreadComment) }),
        }),
      ),
    }),
  }),
});

/** Every review thread on a pull request, or only the unresolved ones. */
export const threads = Effect.fn("Review.threads")(function* (
  input: ThreadsOptions,
  options?: Omit<GhOptions, "stdin">,
) {
  const query = yield* decodeOptions(threadsOptions, input);
  const { owner, name, hostname } = splitRepository(query.repo);

  const nodes = yield* collectPages((after) =>
    Graphql.query(
      threadsDocument,
      { owner, name, number: query.number, after },
      threadsPage,
      onHost(options, hostname),
    ).pipe(Effect.map((data) => data.repository.pullRequest.reviewThreads)),
  );

  return nodes
    .filter((thread) => !query.unresolvedOnly || !thread.isResolved)
    .map((thread): Thread => ({ ...thread, comments: thread.comments.nodes }));
});

const threadOptions = Schema.Struct({
  threadId: Schema.NonEmptyString,
  /** GitHub Enterprise Server host; defaults to gh's. */
  hostname: Schema.optionalKey(Schema.NonEmptyString),
});

export interface ThreadOptions extends Schema.Schema.Type<
  typeof threadOptions
> {}

const replyOptions = Schema.Struct({
  ...threadOptions.fields,
  body: Schema.NonEmptyString,
});

export interface ReplyOptions extends Schema.Schema.Type<typeof replyOptions> {}

const replyDocument = `mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment { id url }
  }
}`;

const replyResponse = Schema.Struct({
  addPullRequestReviewThreadReply: Schema.Struct({
    comment: Schema.Struct({ id: Schema.String, url: Schema.String }),
  }),
});

/** Reply to a review thread and return the new comment's node ID and URL. */
export const reply = Effect.fn("Review.reply")(function* (
  input: ReplyOptions,
  options?: Omit<GhOptions, "stdin">,
) {
  const query = yield* decodeOptions(replyOptions, input);

  const data = yield* Graphql.query(
    replyDocument,
    { threadId: query.threadId, body: query.body },
    replyResponse,
    onHost(options, query.hostname),
  );

  return data.addPullRequestReviewThreadReply.comment;
});

const ResolvedThread = Schema.Struct({
  thread: Schema.Struct({ id: Schema.String, isResolved: Schema.Boolean }),
});

/** Resolve a review thread. */
export const resolve = Effect.fn("Review.resolve")(function* (
  input: ThreadOptions,
  options?: Omit<GhOptions, "stdin">,
) {
  const query = yield* decodeOptions(threadOptions, input);

  const data = yield* Graphql.query(
    `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`,
    { threadId: query.threadId },
    Schema.Struct({ resolveReviewThread: ResolvedThread }),
    onHost(options, query.hostname),
  );

  return data.resolveReviewThread.thread;
});

/** Unresolve a review thread. */
export const unresolve = Effect.fn("Review.unresolve")(function* (
  input: ThreadOptions,
  options?: Omit<GhOptions, "stdin">,
) {
  const query = yield* decodeOptions(threadOptions, input);

  const data = yield* Graphql.query(
    `mutation($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`,
    { threadId: query.threadId },
    Schema.Struct({ unresolveReviewThread: ResolvedThread }),
    onHost(options, query.hostname),
  );

  return data.unresolveReviewThread.thread;
});

const side = Schema.Literals(["LEFT", "RIGHT"]);

const InlineComment = Schema.Struct({
  path: Schema.NonEmptyString,
  body: Schema.NonEmptyString,
  /** The last line of the range the comment applies to. */
  line: positiveInteger,
  /** Defaults to RIGHT, the new side of the diff. */
  side: Schema.optionalKey(side),
  /** The first line, for a multi-line comment. */
  startLine: Schema.optionalKey(positiveInteger),
  /** Defaults to `side`. */
  startSide: Schema.optionalKey(side),
});

export interface InlineComment extends Schema.Schema.Type<
  typeof InlineComment
> {}

const submitOptions = Schema.Struct({
  ...pullRequestOptions.fields,
  event: Schema.Literals(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
  /** Required by GitHub for REQUEST_CHANGES and COMMENT. */
  body: Schema.optionalKey(Schema.String),
  comments: Schema.optionalKey(Schema.Array(InlineComment)),
  /** Review this commit instead of the head. */
  commitId: Schema.optionalKey(Schema.NonEmptyString),
});

export interface SubmitOptions extends Schema.Schema.Type<
  typeof submitOptions
> {}

export const Submitted = Schema.Struct({
  id: Schema.Int,
  nodeId: Schema.String,
  state: Schema.String,
  url: Schema.String,
});

export interface Submitted extends Schema.Schema.Type<typeof Submitted> {}

const submitResponse = Schema.Struct({
  id: Schema.Int,
  node_id: Schema.String,
  state: Schema.String,
  html_url: Schema.String,
});

interface ReviewBody {
  event: SubmitOptions["event"];
  comments: ReadonlyArray<{ readonly [key: string]: string | number }>;
  body?: string;
  commit_id?: string;
}

/** Submit a review, with optional inline comments on lines of the diff. Never retries. */
export const submit = Effect.fn("Review.submit")(function* (
  input: SubmitOptions,
  options?: Omit<GhOptions, "stdin">,
) {
  const query = yield* decodeOptions(submitOptions, input);
  const { owner, name, hostname } = splitRepository(query.repo);

  const body: ReviewBody = {
    event: query.event,
    comments: (query.comments ?? []).map((comment) => {
      const side = comment.side ?? "RIGHT";

      const inline = {
        path: comment.path,
        body: comment.body,
        line: comment.line,
        side,
      };

      return comment.startLine === undefined
        ? inline
        : {
            ...inline,
            start_line: comment.startLine,
            start_side: comment.startSide ?? side,
          };
    }),
  };

  if (query.body !== undefined) body.body = query.body;

  if (query.commitId !== undefined) body.commit_id = query.commitId;

  const response = yield* Api.json(
    restRequest(
      {
        endpoint: `repos/${owner}/${name}/pulls/${query.number}/reviews`,
        method: "POST",
        body: { ...body },
      },
      hostname,
      options,
    ),
    submitResponse,
  );

  return Submitted.make({
    id: response.id,
    nodeId: response.node_id,
    state: response.state,
    url: response.html_url,
  });
});
