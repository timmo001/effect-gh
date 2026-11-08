import { Effect, Schema } from "effect";
import { Gh, type GhOptions } from "./gh.js";

/** An agent task as `gh agent-task list` and `view` return it (preview). */
export const Task = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** Session state, such as `queued`, `in_progress` or `completed`. */
  state: Schema.String,
  repository: Schema.String,
  user: Schema.String,
  pullRequestNumber: Schema.Int,
  pullRequestState: Schema.String,
  pullRequestTitle: Schema.String,
  pullRequestUrl: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  /** Empty or a zero time while the task is running. */
  completedAt: Schema.String,
});

export interface Task extends Schema.Schema.Type<typeof Task> {}

const fields = Object.keys(Task.fields).join(",");

/** Input for {@link create}: exactly one of `description` and `file`. */
export type CreateInput = (
  | { readonly description: string; readonly file?: undefined }
  | { readonly file: string; readonly description?: undefined }
) & {
  readonly repo?: string;
  /** Base branch for the pull request; the default branch when omitted. */
  readonly base?: string;
  /** Custom agent name, such as `my-agent` for `my-agent.md`. */
  readonly customAgent?: string;
};

/** Create an agent task and return gh's output, which links the new session. */
export const create = Effect.fn("AgentTask.create")(function* (
  input: CreateInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return (yield* gh.execute(
    [
      "agent-task",
      "create",
      ...(input.repo === undefined ? [] : ["--repo", input.repo]),
      ...(input.base === undefined ? [] : ["--base", input.base]),
      ...(input.customAgent === undefined
        ? []
        : ["--custom-agent", input.customAgent]),
      ...(input.file === undefined ? [] : ["--from-file", input.file]),
      ...(input.description === undefined ? [] : ["--", input.description]),
    ],
    options,
  )).stdout.trim();
});

/** Recent agent tasks, newest first. */
export const list = Effect.fn("AgentTask.list")(function* (
  input: { readonly limit?: number } = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "agent-task",
      "list",
      "--json",
      fields,
      ...(input.limit === undefined ? [] : ["--limit", String(input.limit)]),
    ],
    Schema.Array(Task),
    options,
  );
});

/** View one agent task by session ID, pull request number, URL or branch. */
export const view = Effect.fn("AgentTask.view")(function* (
  input: { readonly repo?: string; readonly task: string | number },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "agent-task",
      "view",
      ...(input.repo === undefined ? [] : ["--repo", input.repo]),
      "--json",
      fields,
      "--",
      String(input.task),
    ],
    Task,
    options,
  );
});
