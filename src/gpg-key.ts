import { Effect } from "effect";
import { Gh, type GhOptions } from "./gh.js";

/** Input for {@link add}: a public key file, or the armored key text sent on stdin. */
export type AddInput = (
  { readonly keyFile: string } | { readonly key: string }
) & {
  readonly title?: string;
};

/** Add a GPG key to your account. */
export const add = Effect.fn("GpgKey.add")(function* (
  input: AddInput,
  options?: Omit<GhOptions, "stdin">,
) {
  const gh = yield* Gh;
  const args = ["gpg-key", "add"];

  if (input.title !== undefined) args.push("--title", input.title);

  if ("keyFile" in input) {
    args.push("--", input.keyFile);
    yield* gh.execute(args, options);

    return;
  }

  args.push("-");
  yield* gh.execute(args, { ...options, stdin: input.key });
});

/** Delete a GPG key by key ID without prompting. */
export const remove = Effect.fn("GpgKey.remove")(function* (
  keyId: string,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(["gpg-key", "delete", "--yes", "--", keyId], options);
});

/** Your GPG keys as gh prints them. gh has no JSON output for this and its table's columns are not a stable format. */
export const list = Effect.fn("GpgKey.list")(function* (options?: GhOptions) {
  const gh = yield* Gh;

  return (yield* gh.execute(["gpg-key", "list"], options)).stdout;
});
