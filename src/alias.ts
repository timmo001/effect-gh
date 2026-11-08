import { Effect } from "effect";
import { Gh, type GhOptions } from "./gh.js";

/** Every alias as gh prints it: a YAML map of alias to expansion. */
export const list = Effect.fn("Alias.list")(function* (options?: GhOptions) {
  const gh = yield* Gh;

  return (yield* gh.execute(["alias", "list"], options)).stdout;
});

/** Input for {@link set}. */
export interface SetInput {
  readonly name: string;
  readonly expansion: string;
  /** Overwrite an existing alias of the same name. */
  readonly clobber?: boolean;
  /** Run the expansion through `sh`. */
  readonly shell?: boolean;
}

/** Define an alias. The expansion is sent on stdin so it needs no quoting. */
export const set = Effect.fn("Alias.set")(function* (
  input: SetInput,
  options?: Omit<GhOptions, "stdin">,
) {
  const gh = yield* Gh;
  const args = ["alias", "set"];

  if (input.clobber) args.push("--clobber");

  if (input.shell) args.push("--shell");
  args.push("--", input.name, "-");
  yield* gh.execute(args, { ...options, stdin: input.expansion });
});

/** Delete an alias, or every alias with `{ all: true }`. */
export const remove = Effect.fn("Alias.remove")(function* (
  input: { readonly name: string } | { readonly all: true },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    "all" in input
      ? ["alias", "delete", "--all"]
      : ["alias", "delete", "--", input.name],
    options,
  );
});

/**
 * Import aliases from a YAML map, given as a file path or as `yaml` text sent
 * on stdin.
 */
export const importAliases = Effect.fn("Alias.importAliases")(function* (
  input: ({ readonly file: string } | { readonly yaml: string }) & {
    readonly clobber?: boolean;
  },
  options?: Omit<GhOptions, "stdin">,
) {
  const gh = yield* Gh;
  const args = ["alias", "import"];

  if (input.clobber) args.push("--clobber");

  if ("file" in input) {
    args.push("--", input.file);
    yield* gh.execute(args, options);

    return;
  }

  args.push("-");
  yield* gh.execute(args, { ...options, stdin: input.yaml });
});
