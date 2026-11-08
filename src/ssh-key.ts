import { Effect } from "effect";
import { Gh, type GhOptions } from "./gh.js";

/** Input for {@link add}: a public key file, or the key text sent on stdin. */
export type AddInput = (
  { readonly keyFile: string } | { readonly key: string }
) & {
  readonly title?: string;
  /** Use the key for `authentication` (the default) or commit `signing`. */
  readonly type?: "authentication" | "signing";
};

/** Add an SSH key to your account. */
export const add = Effect.fn("SshKey.add")(function* (
  input: AddInput,
  options?: Omit<GhOptions, "stdin">,
) {
  const gh = yield* Gh;
  const args = ["ssh-key", "add"];

  if (input.title !== undefined) args.push("--title", input.title);

  if (input.type !== undefined) args.push("--type", input.type);

  if ("keyFile" in input) {
    args.push("--", input.keyFile);
    yield* gh.execute(args, options);

    return;
  }

  args.push("-");
  yield* gh.execute(args, { ...options, stdin: input.key });
});

/** Delete an SSH key by ID without prompting. */
export const remove = Effect.fn("SshKey.remove")(function* (
  id: string,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(["ssh-key", "delete", "--yes", "--", id], options);
});

/** Your SSH keys as gh prints them. gh has no JSON output for this and its table's columns are not a stable format. */
export const list = Effect.fn("SshKey.list")(function* (options?: GhOptions) {
  const gh = yield* Gh;

  return (yield* gh.execute(["ssh-key", "list"], options)).stdout;
});
