import { Effect } from "effect";
import { Gh, type GhOptions } from "./gh.js";

/** `--repo` arguments; gh selects the working directory's repository without them. */
const repoArgs = (repo: string | undefined) =>
  repo === undefined ? [] : ["--repo", repo];

/** Input for {@link list}. */
export interface ListInput {
  /** [HOST/]OWNER/REPO; the working directory's repository without it. */
  readonly repo?: string;
  /** List an organisation's rulesets instead, which needs the `admin:org` scope. */
  readonly org?: string;
  /** At most this many rulesets, 30 by default. */
  readonly limit?: number;
  /** Include rulesets configured at higher levels; gh's default is `true`. */
  readonly parents?: boolean;
}

/** List rulesets as gh prints them; gh offers no JSON for rulesets. */
export const list = Effect.fn("Ruleset.list")(function* (
  input: ListInput = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;

  const output = yield* gh.execute(
    [
      "ruleset",
      "list",
      ...repoArgs(input.repo),
      ...(input.org === undefined ? [] : ["--org", input.org]),
      ...(input.limit === undefined ? [] : ["--limit", String(input.limit)]),
      ...(input.parents === undefined ? [] : [`--parents=${input.parents}`]),
    ],
    options,
  );

  return output.stdout;
});

/** Input for {@link view}. */
export interface ViewInput {
  readonly repo?: string;
  readonly id: number;
  /** The organisation, when the ruleset is organisation-level. */
  readonly org?: string;
  readonly parents?: boolean;
}

/** View a ruleset as gh prints it; gh offers no JSON for rulesets. */
export const view = Effect.fn("Ruleset.view")(function* (
  input: ViewInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  const output = yield* gh.execute(
    [
      "ruleset",
      "view",
      ...repoArgs(input.repo),
      ...(input.org === undefined ? [] : ["--org", input.org]),
      ...(input.parents === undefined ? [] : [`--parents=${input.parents}`]),
      "--",
      String(input.id),
    ],
    options,
  );

  return output.stdout;
});

/** Input for {@link check}. */
export interface CheckInput {
  readonly repo?: string;
  /** The branch, which need not exist; the current branch without it. */
  readonly branch?: string;
  /** Check the default branch instead. */
  readonly default?: boolean;
}

/** The rules that apply to a branch, as gh prints them. */
export const check = Effect.fn("Ruleset.check")(function* (
  input: CheckInput = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;

  const output = yield* gh.execute(
    [
      "ruleset",
      "check",
      ...repoArgs(input.repo),
      ...(input.default ? ["--default"] : []),
      ...(input.branch === undefined ? [] : ["--", input.branch]),
    ],
    options,
  );

  return output.stdout;
});
