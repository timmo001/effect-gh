import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Schema } from "effect";
import { Api, layer } from "../src/index.js";

export const Notification = Schema.Struct({
  id: Schema.String,
  unread: Schema.Boolean,
  reason: Schema.String,
  updated_at: Schema.String,
  last_read_at: Schema.NullOr(Schema.String),
  url: Schema.String,
  repository: Schema.Struct({
    full_name: Schema.String,
    html_url: Schema.String,
  }),
  subject: Schema.Struct({
    title: Schema.String,
    type: Schema.String,
    url: Schema.NullOr(Schema.String),
    latest_comment_url: Schema.NullOr(Schema.String),
  }),
});
export interface Notification extends Schema.Schema.Type<typeof Notification> {}

export interface ListOptions {
  readonly all?: boolean;
  readonly participating?: boolean;
  readonly since?: string;
}

export const listNotifications = Effect.fn("Notifications.list")(function* (
  options: ListOptions = {},
) {
  const threads = yield* Api.json(
    {
      endpoint: "notifications",
      method: "GET",
      query: {
        per_page: 50,
        ...(options.all !== undefined && { all: options.all }),
        ...(options.participating !== undefined && {
          participating: options.participating,
        }),
        ...(options.since !== undefined && { since: options.since }),
      },
    },
    Schema.Array(Notification),
  );
  // This is one page, so fetchedCount is not the total inbox count.
  return {
    threads,
    fetchedCount: threads.length,
    mayHaveMore: threads.length === 50,
  };
});

export const markRead = Effect.fn("Notifications.markRead")(function* (
  threadId: string,
) {
  return yield* Api.raw({
    endpoint: `notifications/threads/${encodeURIComponent(threadId)}`,
    method: "PATCH",
  });
});

export const markDone = Effect.fn("Notifications.markDone")(function* (
  threadId: string,
) {
  return yield* Api.raw({
    endpoint: `notifications/threads/${encodeURIComponent(threadId)}`,
    method: "DELETE",
  });
});

export const setIgnored = Effect.fn("Notifications.setIgnored")(function* (
  threadId: string,
  ignored: boolean,
) {
  return yield* Api.raw({
    endpoint: `notifications/threads/${encodeURIComponent(threadId)}/subscription`,
    method: "PUT",
    body: { ignored },
  });
});

// The caller still chooses when and how to run this effect.
export const listNotificationsOnNode = Effect.fn("Notifications.listOnNode")(
  function* (cwd: string, options: ListOptions = {}) {
    return yield* listNotifications(options).pipe(
      Effect.provide(
        layer({ cwd, timeout: "30 seconds" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  },
);
