import { Effect, Schema } from "effect";
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
  splitRepository,
} from "./internal.js";

export const Summary = Schema.Struct({
  id: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  author: Author,
  category: Schema.Struct({ name: Schema.String }),
  closed: Schema.Boolean,
  /** Null in categories that don't take answers. */
  isAnswered: Schema.NullOr(Schema.Boolean),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export interface Summary extends Schema.Schema.Type<typeof Summary> {}

export const Discussion = Schema.Struct({
  ...Summary.fields,
  body: Schema.String,
});

export interface Discussion extends Schema.Schema.Type<typeof Discussion> {}

export const Reply = Schema.Struct({
  id: Schema.String,
  databaseId: Schema.NullOr(Schema.Int),
  author: Author,
  body: Schema.String,
  createdAt: Schema.String,
  url: Schema.String,
});

export interface Reply extends Schema.Schema.Type<typeof Reply> {}

export const Comment = Schema.Struct({
  ...Reply.fields,
  isAnswer: Schema.Boolean,
  /** The first 100 replies. */
  replies: Schema.Array(Reply),
});

export interface Comment extends Schema.Schema.Type<typeof Comment> {}

const summaryFields =
  "id number title url author { login } category { name } closed isAnswered createdAt updatedAt";

const replyFields = "id databaseId author { login } body createdAt url";

const viewOptions = Schema.Struct({
  repo: repository,
  number: positiveInteger,
});

export interface ViewOptions extends Schema.Schema.Type<typeof viewOptions> {}

const viewDocument = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    discussion(number: $number) { ${summaryFields} body }
  }
}`;

const viewResponse = Schema.Struct({
  repository: Schema.Struct({ discussion: Discussion }),
});

/** View a discussion, including its body. */
export const view = Effect.fn("Discussion.view")(function* (
  input: ViewOptions,
  options?: Omit<GhOptions, "stdin">,
) {
  const query = yield* decodeOptions(viewOptions, input);
  const { owner, name, hostname } = splitRepository(query.repo);

  return (yield* Graphql.query(
    viewDocument,
    { owner, name, number: query.number },
    viewResponse,
    onHost(options, hostname),
  )).repository.discussion;
});

const listOptions = Schema.Struct({
  repo: repository,
  /** Defaults to open. */
  state: Schema.optionalKey(Schema.Literals(["open", "closed", "all"])),
  /** Defaults to 30. */
  limit: Schema.optionalKey(positiveInteger),
});

export interface ListOptions extends Schema.Schema.Type<typeof listOptions> {}

const listDocument = `query($owner: String!, $name: String!, $states: [DiscussionState!], $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    discussions(first: $first, after: $after, states: $states, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { ${summaryFields} }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const listResponse = Schema.Struct({
  repository: Schema.Struct({ discussions: connection(Summary) }),
});

/** List discussions, most recently updated first. */
export const list = Effect.fn("Discussion.list")(function* (
  input: ListOptions,
  options?: Omit<GhOptions, "stdin">,
) {
  const query = yield* decodeOptions(listOptions, input);
  const { owner, name, hostname } = splitRepository(query.repo);
  const limit = query.limit ?? 30;
  const state = query.state ?? "open";

  return yield* collectPages(
    (after) =>
      Graphql.query(
        listDocument,
        {
          owner,
          name,
          states: state === "all" ? null : [state.toUpperCase()],
          first: Math.min(limit, 100),
          after,
        },
        listResponse,
        onHost(options, hostname),
      ).pipe(Effect.map((data) => data.repository.discussions)),
    limit,
  );
});

const commentsDocument = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    discussion(number: $number) {
      comments(first: 100, after: $after) {
        nodes {
          ${replyFields} isAnswer
          replies(first: 100) { nodes { ${replyFields} } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const commentsResponse = Schema.Struct({
  repository: Schema.Struct({
    discussion: Schema.Struct({
      comments: connection(
        Schema.Struct({
          ...Comment.fields,
          replies: Schema.Struct({ nodes: Schema.Array(Reply) }),
        }),
      ),
    }),
  }),
});

/** Every top-level comment on a discussion, oldest first, with its replies. */
export const comments = Effect.fn("Discussion.comments")(function* (
  input: ViewOptions,
  options?: Omit<GhOptions, "stdin">,
) {
  const query = yield* decodeOptions(viewOptions, input);
  const { owner, name, hostname } = splitRepository(query.repo);

  const nodes = yield* collectPages((after) =>
    Graphql.query(
      commentsDocument,
      { owner, name, number: query.number, after },
      commentsResponse,
      onHost(options, hostname),
    ).pipe(Effect.map((data) => data.repository.discussion.comments)),
  );

  return nodes.map((node): Comment => ({
    ...node,
    replies: node.replies.nodes,
  }));
});

const commentOptions = Schema.Struct({
  ...viewOptions.fields,
  body: Schema.NonEmptyString,
});

export interface CommentOptions extends Schema.Schema.Type<
  typeof commentOptions
> {}

const idDocument = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { discussion(number: $number) { id } }
}`;

const addCommentDocument = `mutation($discussionId: ID!, $body: String!, $replyToId: ID) {
  addDiscussionComment(input: { discussionId: $discussionId, body: $body, replyToId: $replyToId }) {
    comment { id url }
  }
}`;

const addCommentResponse = Schema.Struct({
  addDiscussionComment: Schema.Struct({
    comment: Schema.Struct({ id: Schema.String, url: Schema.String }),
  }),
});

/** Add a top-level comment to a discussion and return its node ID and URL. */
export const comment = Effect.fn("Discussion.comment")(function* (
  input: CommentOptions,
  options?: Omit<GhOptions, "stdin">,
) {
  const query = yield* decodeOptions(commentOptions, input);
  const { owner, name, hostname } = splitRepository(query.repo);
  const host = onHost(options, hostname);

  const { discussion } = (yield* Graphql.query(
    idDocument,
    { owner, name, number: query.number },
    Schema.Struct({
      repository: Schema.Struct({
        discussion: Schema.Struct({ id: Schema.String }),
      }),
    }),
    host,
  )).repository;

  return (yield* Graphql.query(
    addCommentDocument,
    { discussionId: discussion.id, body: query.body, replyToId: null },
    addCommentResponse,
    host,
  )).addDiscussionComment.comment;
});

const replyOptions = Schema.Struct({
  /** Node ID of the top-level discussion comment to reply to. */
  commentId: Schema.NonEmptyString,
  body: Schema.NonEmptyString,
  /** GitHub Enterprise Server host; defaults to gh's. */
  hostname: Schema.optionalKey(Schema.NonEmptyString),
});

export interface ReplyOptions extends Schema.Schema.Type<typeof replyOptions> {}

const commentDiscussionDocument = `query($id: ID!) {
  node(id: $id) { ... on DiscussionComment { discussion { id } } }
}`;

/** Reply to a top-level discussion comment and return the reply's node ID and URL. */
export const reply = Effect.fn("Discussion.reply")(function* (
  input: ReplyOptions,
  options?: Omit<GhOptions, "stdin">,
) {
  const query = yield* decodeOptions(replyOptions, input);
  const host = onHost(options, query.hostname);

  const { node } = yield* Graphql.query(
    commentDiscussionDocument,
    { id: query.commentId },
    Schema.Struct({
      node: Schema.Struct({
        discussion: Schema.Struct({ id: Schema.String }),
      }),
    }),
    host,
  );

  return (yield* Graphql.query(
    addCommentDocument,
    {
      discussionId: node.discussion.id,
      body: query.body,
      replyToId: query.commentId,
    },
    addCommentResponse,
    host,
  )).addDiscussionComment.comment;
});
