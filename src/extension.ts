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

/** Options for {@link install}, {@link remove} and the upgrades. */
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

/** Remove an installed extension by name, such as `dash`. */
export const remove = Effect.fn("Extension.remove")(function* (
  name: string,
  options?: InstallOptions,
) {
  yield* run(["extension", "remove", name], options);
});

/** Options for {@link upgrade} and {@link upgradeAll}. */
export interface UpgradeOptions extends InstallOptions {
  /** Upgrade pinned extensions too, resetting git extensions to their remote's HEAD. */
  readonly force?: boolean;
}

const upgradeArgs = (
  target: string,
  options: { readonly force?: boolean } | undefined,
) => [
  "extension",
  "upgrade",
  target,
  ...(options?.force === true ? ["--force"] : []),
];

/** Upgrade one installed extension by name, such as `dash`. */
export const upgrade = Effect.fn("Extension.upgrade")(function* (
  name: string,
  options?: UpgradeOptions,
) {
  yield* run(upgradeArgs(name, options), options);
});

/** Upgrade every installed extension. */
export const upgradeAll = Effect.fn("Extension.upgradeAll")(function* (
  options?: UpgradeOptions,
) {
  yield* run(upgradeArgs("--all", options), options);
});

/** What `gh extension upgrade` did, or would do in a dry run, with one extension. */
export interface Upgrade {
  readonly name: string;
  /**
   * `upgraded` (or would be, in a dry run), `current` when already up to date,
   * `pinned` or `local` when gh won't upgrade it, or `failed`.
   */
  readonly status: "upgraded" | "current" | "pinned" | "local" | "failed";
  /** Version before the upgrade; empty unless `upgraded`. */
  readonly from: string;
  /** Version after the upgrade; empty unless `upgraded`. */
  readonly to: string;
  /** gh's message for a failure; empty otherwise. */
  readonly reason: string;
}

const upgradeLine = /^\[\s*(.+?)\]: (.*)$/;
const upgradedMessage = /^(?:would have )?upgraded from (\S*) to (\S*)$/;

const messageStatus = (message: string): Upgrade["status"] => {
  switch (message) {
    case "already up to date":
      return "current";
    case "pinned extensions can not be upgraded":
      return "pinned";
    case "local extensions can not be upgraded":
      return "local";
    default:
      return "failed";
  }
};

const parseUpgradeLine = (name: string, message: string): Upgrade => {
  const upgraded = upgradedMessage.exec(message);

  if (upgraded !== null)
    return {
      name,
      status: "upgraded",
      from: upgraded[1] ?? "",
      to: upgraded[2] ?? "",
      reason: "",
    };

  const status = messageStatus(message);

  return {
    name,
    status,
    from: "",
    to: "",
    reason: status === "failed" ? message : "",
  };
};

/**
 * Parse `gh extension upgrade` output: one `[name]: message` line per
 * extension, with names padded to the longest. A failure's message can run on
 * to further lines, which join its `reason`. gh exits 1 after any failure, so
 * pass `GhCommandError.stdout` here to see what still upgraded.
 */
export const parseUpgrades = (output: string): ReadonlyArray<Upgrade> => {
  const upgrades: Array<Upgrade> = [];

  for (const line of output.split("\n")) {
    const match = upgradeLine.exec(line);

    if (match !== null) {
      upgrades.push(parseUpgradeLine(match[1] ?? "", match[2] ?? ""));
      continue;
    }

    const last = upgrades.at(-1);

    if (last?.status === "failed" && line.trim() !== "")
      upgrades[upgrades.length - 1] = {
        ...last,
        reason: `${last.reason}\n${line}`,
      };
  }

  return upgrades;
};

/** Options for {@link checkUpgrades}. */
export interface CheckUpgradesOptions extends Omit<
  GhOptions,
  "stdin" | "maxOutputBytes"
> {
  /** Check one extension by name instead of every installed one. */
  readonly name?: string;
  /** Count pinned extensions as upgradable. */
  readonly force?: boolean;
}

/**
 * What `gh extension upgrade --dry-run` would do with every installed
 * extension, or one with `name`, without changing anything. An extension whose
 * check failed comes back as `failed` rather than failing the whole check, and
 * no installed extensions give an empty list.
 */
export const checkUpgrades = Effect.fn("Extension.checkUpgrades")(function* (
  options?: CheckUpgradesOptions,
) {
  const gh = yield* Gh;

  return yield* gh
    .execute(
      [...upgradeArgs(options?.name ?? "--all", options), "--dry-run"],
      options,
    )
    .pipe(
      Effect.map((output) => parseUpgrades(output.stdout)),
      Effect.catchTag("GhCommandError", (error) => {
        if (error.stderr.includes("no extensions installed"))
          return Effect.succeed<ReadonlyArray<Upgrade>>([]);

        const upgrades = parseUpgrades(error.stdout);

        return upgrades.some((upgrade) => upgrade.status === "failed")
          ? Effect.succeed(upgrades)
          : Effect.fail(error);
      }),
    );
});

export const SearchResult = Schema.Struct({
  fullName: Schema.String,
  name: Schema.String,
  description: Schema.String,
  url: Schema.String,
  stargazersCount: Schema.Int,
  updatedAt: Schema.String,
});

export interface SearchResult extends Schema.Schema.Type<typeof SearchResult> {}

/** Input for {@link search}. */
export interface SearchInput {
  readonly query?: string;
  readonly owner?: ReadonlyArray<string>;
  readonly license?: ReadonlyArray<string>;
  /** Defaults to gh's 30. */
  readonly limit?: number;
  readonly sort?: "forks" | "help-wanted-issues" | "stars" | "updated";
  readonly order?: "asc" | "desc";
}

/** Search for installable extensions. */
export const search = Effect.fn("Extension.search")(function* (
  input: SearchInput = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "extension",
      "search",
      "--json",
      Object.keys(SearchResult.fields).join(","),
      ...(input.owner ?? []).flatMap((owner) => ["--owner", owner]),
      ...(input.license ?? []).flatMap((license) => ["--license", license]),
      ...(input.limit === undefined ? [] : ["--limit", String(input.limit)]),
      ...(input.sort === undefined ? [] : ["--sort", input.sort]),
      ...(input.order === undefined ? [] : ["--order", input.order]),
      ...(input.query === undefined ? [] : ["--", input.query]),
    ],
    Schema.Array(SearchResult),
    options,
  );
});

/**
 * Run an installed extension by name, such as `dash`, with arguments gh
 * forwards untouched, and return its stdout.
 */
export const exec = Effect.fn("Extension.exec")(function* (
  name: string,
  args: ReadonlyArray<string> = [],
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return (yield* gh.execute(["extension", "exec", name, ...args], options))
    .stdout;
});

/** Input for {@link create}. */
export interface CreateInput {
  /** Extension name, such as `gh-foo`; created as a directory in `options.cwd`. */
  readonly name: string;
  /** Scaffold a precompiled extension instead of a script one. */
  readonly precompiled?: "go" | "other";
}

/** Scaffold a new extension in a directory named after it. */
export const create = Effect.fn("Extension.create")(function* (
  input: CreateInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "extension",
      "create",
      ...(input.precompiled === undefined
        ? []
        : [`--precompiled=${input.precompiled}`]),
      "--",
      input.name,
    ],
    options,
  );
});
