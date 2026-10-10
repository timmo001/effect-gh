import { Effect, Schema } from "effect";
import { Gh, type GhOptions } from "./gh.js";

export const Extension = Schema.Struct({
  /** Command name without the `gh ` prefix, such as `dash`. */
  name: Schema.String,
  /** OWNER/REPO the extension was installed from; empty for local extensions. */
  repository: Schema.String,
  version: Schema.String,
});

export interface Extension extends Schema.Schema.Type<typeof Extension> {}

/** Parse `gh extension list`, which has no JSON output: tab-separated name, repository and version. */
export const parseList = (output: string): ReadonlyArray<Extension> =>
  output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const fields = line.split(/\t|\s{2,}/).map((field) => field.trim());
      const index = fields.findIndex((field) => field.includes("/"));

      return Extension.make({
        name: (fields[0] ?? "").replace(/^gh\s+/, ""),
        repository: index === -1 ? "" : (fields[index] ?? ""),
        version:
          index === -1
            ? ""
            : fields
                .slice(index + 1)
                .filter((field) => field !== "")
                .join(" "),
      });
    });

/** Installed extensions. */
export const list = Effect.fn("Extension.list")(function* (
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return parseList((yield* gh.execute(["extension", "list"], options)).stdout);
});

/** Options for {@link install} and {@link upgradeAll}. */
export interface InstallOptions extends Omit<
  GhOptions,
  "stdin" | "maxOutputBytes"
> {
  /** Run on the terminal so progress and prompts reach the user. */
  readonly interactive?: boolean;
}

const run = (args: ReadonlyArray<string>, options?: InstallOptions) =>
  Effect.gen(function* () {
    const gh = yield* Gh;

    if (options?.interactive) return yield* gh.interactive(args, options);
    yield* gh.execute(args, options);
  });

/** Install an extension from OWNER/REPO. */
export const install = Effect.fn("Extension.install")(function* (
  repository: string,
  options?: InstallOptions,
) {
  yield* run(["extension", "install", repository], options);
});

/** Upgrade every installed extension. */
export const upgradeAll = Effect.fn("Extension.upgradeAll")(function* (
  options?: InstallOptions,
) {
  yield* run(["extension", "upgrade", "--all"], options);
});
