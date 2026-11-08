import { Effect, Schema } from "effect";
import { Gh, type GhOptions } from "./gh.js";

const optional = (flag: string, value: string | undefined) =>
  value === undefined ? [] : [flag, value];

/** An installed skill as `gh skill list` returns it (preview). */
export const Installed = Schema.Struct({
  skillName: Schema.String,
  /** Agent hosts using the skill, or `published` for a skill in this repository. */
  agentHosts: Schema.Array(Schema.String),
  scope: Schema.String,
  /** Empty for skills installed without gh. */
  sourceURL: Schema.String,
  version: Schema.String,
  pinned: Schema.Boolean,
  path: Schema.String,
});

export interface Installed extends Schema.Schema.Type<typeof Installed> {}

/** Input for {@link list}. */
export interface ListInput {
  /** Target agent, such as `github-copilot` or `claude-code`. */
  readonly agent?: string;
  readonly scope?: "project" | "user";
  /** Scan a custom directory. */
  readonly dir?: string;
}

/** Installed skills. */
export const list = Effect.fn("Skill.list")(function* (
  input: ListInput = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "skill",
      "list",
      "--json",
      Object.keys(Installed.fields).join(","),
      ...optional("--agent", input.agent),
      ...optional("--scope", input.scope),
      ...optional("--dir", input.dir),
    ],
    Schema.Array(Installed),
    options,
  );
});

export const SearchResult = Schema.Struct({
  repo: Schema.String,
  skillName: Schema.String,
  namespace: Schema.String,
  description: Schema.String,
  stars: Schema.Int,
  path: Schema.String,
});

export interface SearchResult extends Schema.Schema.Type<typeof SearchResult> {}

/** Input for {@link search}. */
export interface SearchInput {
  readonly query: string;
  readonly owner?: string;
  /** Results per page, 15 by default. */
  readonly limit?: number;
  readonly page?: number;
}

/** Search for skills in GitHub repositories. */
export const search = Effect.fn("Skill.search")(function* (
  input: SearchInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "skill",
      "search",
      "--json",
      Object.keys(SearchResult.fields).join(","),
      ...optional("--owner", input.owner),
      ...(input.limit === undefined ? [] : ["--limit", String(input.limit)]),
      ...(input.page === undefined ? [] : ["--page", String(input.page)]),
      "--",
      input.query,
    ],
    Schema.Array(SearchResult),
    options,
  );
});

/** Input for {@link install}. */
export interface InstallInput {
  /** A repository, or a local directory with `fromLocal`. */
  readonly source: string;
  /** Skill name, optionally `name@version`; omit with `all` to install every skill. */
  readonly skill?: string;
  readonly all?: boolean;
  readonly agent?: string;
  readonly scope?: "project" | "user";
  /** Install to a custom directory instead of the agent and scope's. */
  readonly dir?: string;
  readonly fromLocal?: boolean;
  /** Pin to a git tag or commit SHA. */
  readonly pin?: string;
  readonly allowHiddenDirs?: boolean;
  readonly upstream?: boolean;
  /** Overwrite skills that are already installed; without it, gh refuses them. */
  readonly force?: boolean;
}

/**
 * Install skills: name a `skill` or set `all`, and pass `agent` and `scope`
 * (or `dir`). Existing skills are only overwritten with `force`.
 */
export const install = Effect.fn("Skill.install")(function* (
  input: InstallInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "skill",
      "install",
      ...(input.force === true ? ["--force"] : []),
      ...(input.all === true ? ["--all"] : []),
      ...optional("--agent", input.agent),
      ...optional("--scope", input.scope),
      ...optional("--dir", input.dir),
      ...(input.fromLocal === true ? ["--from-local"] : []),
      ...optional("--pin", input.pin),
      ...(input.allowHiddenDirs === true ? ["--allow-hidden-dirs"] : []),
      ...(input.upstream === true ? ["--upstream"] : []),
      "--",
      input.source,
      ...(input.skill === undefined ? [] : [input.skill]),
    ],
    options,
  );
});

/** Input for {@link update}. */
export interface UpdateInput {
  /** Skills to update; omit to check every installed skill. */
  readonly skills?: ReadonlyArray<string>;
  readonly dir?: string;
  /** Report available updates without changing files. */
  readonly dryRun?: boolean;
  /** Re-download even when up to date. */
  readonly force?: boolean;
  /** Clear pinned versions and include pinned skills. */
  readonly unpin?: boolean;
}

/** Update installed skills without prompting, and return gh's report. */
export const update = Effect.fn("Skill.update")(function* (
  input: UpdateInput = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;
  const skills = input.skills ?? [];

  const output = yield* gh.execute(
    [
      "skill",
      "update",
      ...(skills.length === 0 ? ["--all"] : []),
      ...optional("--dir", input.dir),
      ...(input.dryRun === true ? ["--dry-run"] : []),
      ...(input.force === true ? ["--force"] : []),
      ...(input.unpin === true ? ["--unpin"] : []),
      ...(skills.length === 0 ? [] : ["--", ...skills]),
    ],
    options,
  );

  return output.stdout + output.stderr;
});

/** Input for {@link preview}. */
export interface PreviewInput {
  readonly repository: string;
  /** Skill name; required, since gh prompts to choose without it. */
  readonly skill: string;
  readonly allowHiddenDirs?: boolean;
}

/** A skill's `SKILL.md` content as gh prints it, without installing. */
export const preview = Effect.fn("Skill.preview")(function* (
  input: PreviewInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return (yield* gh.execute(
    [
      "skill",
      "preview",
      ...(input.allowHiddenDirs === true ? ["--allow-hidden-dirs"] : []),
      "--",
      input.repository,
      input.skill,
    ],
    options,
  )).stdout;
});

/** Input for {@link publish}. */
export interface PublishInput {
  /** Directory to publish from; the working directory by default. */
  readonly directory?: string;
  /** Validate without publishing. */
  readonly dryRun?: boolean;
  /** Fix what can be fixed without publishing. */
  readonly fix?: boolean;
  /** Version tag for the release, such as `v1.0.0`; required to publish without a prompt. */
  readonly tag?: string;
}

/** Validate skills and publish them as a release, returning gh's report. */
export const publish = Effect.fn("Skill.publish")(function* (
  input: PublishInput = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;

  const output = yield* gh.execute(
    [
      "skill",
      "publish",
      ...(input.dryRun === true ? ["--dry-run"] : []),
      ...(input.fix === true ? ["--fix"] : []),
      ...optional("--tag", input.tag),
      ...(input.directory === undefined ? [] : ["--", input.directory]),
    ],
    options,
  );

  return output.stdout + output.stderr;
});
