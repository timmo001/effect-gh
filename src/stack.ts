import { Effect, Schema } from "effect";
import type { GhCommandError } from "./errors.js";
import { Gh, type GhOptions } from "./gh.js";

/**
 * Stacked pull requests through the [gh-stack](https://github.com/github/gh-stack)
 * extension, `gh stack`. Install it first with
 * `Extension.install("github/gh-stack")`. Most commands act on the stack of the
 * branch checked out in `options.cwd`, and report progress on stderr.
 *
 * Every command runs piped, so gh-stack takes its non-interactive paths:
 * `submit` uses generated titles and `merge` doesn't ask. The few that only
 * work on a terminal ({@link modify}, {@link switchBranch}, and the pickers
 * behind `interactive`) run through `Gh.interactive`.
 */

/** A branch's pull request in {@link View}. */
export const PullRequest = Schema.Struct({
  number: Schema.Int,
  /** Absent when gh-stack hasn't recorded it. */
  url: Schema.optionalKey(Schema.String),
  state: Schema.Literals(["OPEN", "MERGED", "QUEUED"]),
});

export interface PullRequest extends Schema.Schema.Type<typeof PullRequest> {}

/** One branch of a stack in {@link View}, bottom first. */
export const Branch = Schema.Struct({
  name: Schema.String,
  /** The branch's last known commit. */
  head: Schema.optionalKey(Schema.String),
  /**
   * The parent's commit this branch was last known to contain, which can be
   * older than the parent's tip.
   */
  base: Schema.optionalKey(Schema.String),
  isCurrent: Schema.Boolean,
  isMerged: Schema.Boolean,
  isQueued: Schema.Boolean,
  /** The parent's tip is no longer in this branch's history. */
  needsRebase: Schema.Boolean,
  /** Absent until the branch has a pull request. */
  pr: Schema.optionalKey(PullRequest),
});

export interface Branch extends Schema.Schema.Type<typeof Branch> {}

/** The current stack, from `gh stack view --json`. */
export const View = Schema.Struct({
  trunk: Schema.String,
  currentBranch: Schema.String,
  /** Bottom (next to the trunk) to top. */
  branches: Schema.Array(Branch),
});

export interface View extends Schema.Schema.Type<typeof View> {}

/** What a gh-stack exit code means, from {@link exitReason}. */
export type ExitReason =
  /** The branch or stack isn't tracked; `init` or `checkout` one. */
  | "not-in-stack"
  /** A rebase stopped on a conflict; resolve it, then {@link continueRebase}. */
  | "conflict"
  | "api-failure"
  | "invalid-arguments"
  /** The branch is in several stacks, or the remote is ambiguous. */
  | "disambiguation-required"
  /** {@link continueRebase} or {@link abortRebase} first. */
  | "rebase-in-progress"
  /** Another gh-stack process is writing the stack file; retry shortly. */
  | "stack-locked"
  /** Stacked pull requests aren't enabled for the repository. */
  | "stacks-unavailable"
  /** A {@link modify} was interrupted; {@link abortModify} or {@link continueModify}. */
  | "modify-recovery-required";

const exitReasons = new Map<number, ExitReason>([
  [2, "not-in-stack"],
  [3, "conflict"],
  [4, "api-failure"],
  [5, "invalid-arguments"],
  [6, "disambiguation-required"],
  [7, "rebase-in-progress"],
  [8, "stack-locked"],
  [9, "stacks-unavailable"],
  [10, "modify-recovery-required"],
]);

/**
 * What a failed `gh stack` command's exit code means, or undefined for a
 * generic failure (exit 1, with the reason on stderr).
 */
export const exitReason = (
  error: Pick<GhCommandError, "exitCode">,
): ExitReason | undefined => exitReasons.get(error.exitCode);

/** Options for commands that can open gh-stack's terminal UI instead. */
export interface InteractiveOptions extends Omit<
  GhOptions,
  "stdin" | "maxOutputBytes"
> {
  /** Run on the terminal so gh-stack's editor, picker or wizard reaches the user. */
  readonly interactive?: boolean;
}

/** Input shared by the commands that push. */
export interface PushInput {
  /** Remote to push to, needed when there are several and `remote.pushDefault` isn't set. */
  readonly remote?: string;
  /**
   * Push every branch or none, gh-stack's default. False allows partial
   * updates; true overrides `GH_STACK_NO_ATOMIC`.
   */
  readonly atomic?: boolean;
}

/** Input for the commands that can rebase onto a base GitHub retargeted. */
export interface RetargetInput {
  /** Rebase onto a retargeted base even when the old base never merged, dropping its commits. */
  readonly acceptBaseChange?: boolean;
}

const pushArgs = (input: PushInput) => [
  ...(input.remote === undefined ? [] : [`--remote=${input.remote}`]),
  ...(input.atomic === undefined
    ? []
    : [input.atomic ? "--no-atomic=false" : "--no-atomic"]),
];

const retargetArgs = (input: RetargetInput) =>
  input.acceptBaseChange ? ["--accept-base-change"] : [];

const run = Effect.fn("Stack.run")(function* (
  args: ReadonlyArray<string>,
  options?: GhOptions & { readonly interactive?: boolean },
) {
  const gh = yield* Gh;

  if (options?.interactive)
    return yield* gh.interactive(["stack", ...args], options);
  yield* gh.execute(["stack", ...args], options);
});

const stdout = Effect.fn("Stack.stdout")(function* (
  args: ReadonlyArray<string>,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return (yield* gh.execute(["stack", ...args], options)).stdout.trim();
});

/** The installed gh-stack version, such as `0.3.0`. */
export const version = Effect.fn("Stack.version")(function* (
  options?: GhOptions,
) {
  const output = yield* stdout(["--version"], options);

  return output.replace(/^gh stack version\s+/, "");
});

/** The stack of the checked-out branch. Fails with `not-in-stack` outside one. */
export const view = Effect.fn("Stack.view")(function* (options?: GhOptions) {
  const gh = yield* Gh;

  return yield* gh.json(["stack", "view", "--json"], View, options);
});

/** Input for {@link init}. */
export interface InitInput {
  /** Trunk branch; the repository's default branch without it. */
  readonly base?: string;
}

/**
 * Start a stack from branches, bottom first, and check out the top one.
 * Existing branches are adopted and missing ones created, each on the one
 * before it.
 */
export const init = Effect.fn("Stack.init")(function* (
  branches: readonly [string, ...string[]],
  input: InitInput = {},
  options?: GhOptions,
) {
  yield* run(
    [
      "init",
      ...(input.base === undefined ? [] : [`--base=${input.base}`]),
      "--",
      ...branches,
    ],
    options,
  );
});

/** A commit for {@link add} to make on the new branch. */
export interface AddCommit {
  readonly message: string;
  /**
   * Stage `all` changes, untracked files included, or only `tracked` files
   * first; commits what's already staged without it.
   */
  readonly stage?: "all" | "tracked";
}

/** Input for {@link add}: a branch name, a commit, or both. */
export type AddInput =
  | { readonly branch: string; readonly commit?: AddCommit }
  /** Without a branch, its name comes from the commit message. */
  | { readonly branch?: undefined; readonly commit: AddCommit };

/** Add a branch on top of the stack and check it out, optionally committing to it. */
export const add = Effect.fn("Stack.add")(function* (
  input: AddInput,
  options?: GhOptions,
) {
  const commit = input.commit;

  yield* run(
    [
      "add",
      ...(commit?.stage === "all" ? ["--all"] : []),
      ...(commit?.stage === "tracked" ? ["--update"] : []),
      ...(commit === undefined ? [] : [`--message=${commit.message}`]),
      ...(input.branch === undefined ? [] : ["--", input.branch]),
    ],
    options,
  );
});

/**
 * A stack number (as on GitHub), a pull request number or URL, or a branch.
 * A bare number is tried as a stack first.
 */
export type CheckoutTarget = number | string;

const checkoutArgs = (target: CheckoutTarget) => [
  "checkout",
  "--",
  String(target),
];

/**
 * Check out a stack, fetching it from GitHub when it isn't tracked locally.
 * Without a target, the user picks from every stack in a terminal UI.
 */
export const checkout = Effect.fn("Stack.checkout")(function* (
  target: CheckoutTarget | undefined,
  options?: InteractiveOptions,
) {
  yield* run(
    target === undefined ? ["checkout"] : checkoutArgs(target),
    target === undefined ? { ...options, interactive: true } : options,
  );
});

/**
 * {@link checkout}, returning the worktree that holds the target branch. A
 * branch checked out in another worktree stays there; an unoccupied one is
 * checked out in `options.cwd` first.
 */
export const checkoutPath = Effect.fn("Stack.checkoutPath")(function* (
  target: CheckoutTarget,
  options?: GhOptions,
) {
  return yield* stdout([...checkoutArgs(target), "--print-path"], options);
});

/** Where {@link navigate} moves in the stack. Merged branches are skipped. */
export type Navigation =
  /** Away from the trunk, one branch or `count`. */
  | { readonly to: "up"; readonly count?: number }
  /** Towards the trunk, one branch or `count`. */
  | { readonly to: "down"; readonly count?: number }
  | { readonly to: "top" | "bottom" | "trunk" };

const navigationArgs = (navigation: Navigation) => [
  navigation.to,
  ...("count" in navigation && navigation.count !== undefined
    ? ["--", String(navigation.count)]
    : []),
];

/** Check out another branch of the stack. */
export const navigate = Effect.fn("Stack.navigate")(function* (
  navigation: Navigation,
  options?: GhOptions,
) {
  yield* run(navigationArgs(navigation), options);
});

/**
 * {@link navigate}, returning the worktree that holds the target branch
 * without switching a branch checked out elsewhere.
 */
export const navigatePath = Effect.fn("Stack.navigatePath")(function* (
  navigation: Navigation,
  options?: GhOptions,
) {
  return yield* stdout(
    [navigation.to, "--print-path", ...navigationArgs(navigation).slice(1)],
    options,
  );
});

/** Pick a branch of the stack to check out, in a terminal UI. */
export const switchBranch = Effect.fn("Stack.switchBranch")(function* (
  options?: Omit<InteractiveOptions, "interactive">,
) {
  yield* run(["switch"], { ...options, interactive: true });
});

/**
 * Restructure the stack in gh-stack's terminal UI: drop, fold, insert,
 * reorder or rename branches. It has no non-interactive form.
 */
export const modify = Effect.fn("Stack.modify")(function* (
  options?: Omit<InteractiveOptions, "interactive">,
) {
  yield* run(["modify"], { ...options, interactive: true });
});

/** Carry on with an interrupted {@link modify} after resolving its conflicts. */
export const continueModify = Effect.fn("Stack.continueModify")(function* (
  options?: GhOptions,
) {
  yield* run(["modify", "--continue"], options);
});

/** Abandon an interrupted {@link modify}, restoring the stack as it was. */
export const abortModify = Effect.fn("Stack.abortModify")(function* (
  options?: GhOptions,
) {
  yield* run(["modify", "--abort"], options);
});

/** Input for {@link unstack}. */
export interface UnstackInput {
  /** Stack number on GitHub; the checked-out branch's stack without it. */
  readonly stack?: number;
  /** Only stop tracking it locally, keeping the stack on GitHub. */
  readonly local?: boolean;
}

/**
 * Unstack the pull requests on GitHub and stop tracking the stack locally.
 * Merged and queued pull requests stay stacked on GitHub.
 */
export const unstack = Effect.fn("Stack.unstack")(function* (
  input: UnstackInput = {},
  options?: GhOptions,
) {
  yield* run(
    [
      "unstack",
      ...(input.local ? ["--local"] : []),
      ...(input.stack === undefined ? [] : ["--", String(input.stack)]),
    ],
    options,
  );
});

/** Input for {@link submit}. */
export interface SubmitInput extends PushInput {
  /** Mark new and existing pull requests ready for review; new ones are drafts without it. */
  readonly open?: boolean;
}

/**
 * Push every branch, open a pull request for each branch without one, fix
 * their bases and create or update the stack on GitHub. New pull requests get
 * generated titles; with `interactive`, gh-stack's editor lets the user write
 * them.
 */
export const submit = Effect.fn("Stack.submit")(function* (
  input: SubmitInput = {},
  options?: InteractiveOptions,
) {
  yield* run(
    [
      "submit",
      ...(options?.interactive ? [] : ["--auto"]),
      ...(input.open ? ["--open"] : []),
      ...pushArgs(input),
    ],
    options,
  );
});

/** Push the stack's active branches with `--force-with-lease`, skipping merged and queued ones. */
export const push = Effect.fn("Stack.push")(function* (
  input: PushInput = {},
  options?: GhOptions,
) {
  yield* run(["push", ...pushArgs(input)], options);
});

/** Input for {@link sync}. */
export interface SyncInput extends PushInput, RetargetInput {
  /** Delete local branches of merged pull requests. */
  readonly prune?: boolean;
}

/**
 * How {@link sync} ended: `stack` when the stack on GitHub now matches the
 * local one, `branches` when branches were rebased and pushed but there was
 * no stack on GitHub to update (fewer than two pull requests), and `diverged`
 * when the local and remote stacks differ, so nothing changed. Check a
 * diverged stack out from GitHub with {@link checkout}, or sync it on a
 * terminal.
 */
export type SyncResult = "stack" | "branches" | "diverged";

/** Read how `gh stack sync` ended from its stderr. */
export const parseSync = (stderr: string): SyncResult =>
  stderr.includes("Sync aborted")
    ? "diverged"
    : stderr.includes("Stack synced")
      ? "stack"
      : "branches";

/**
 * Fetch, pull in branches added to the stack on GitHub, fast-forward the
 * trunk, rebase every branch onto its parent, push and refresh pull request
 * state, linking the stack on GitHub. It never opens pull requests. A rebase
 * conflict restores every branch and fails with `conflict`; run
 * {@link rebase} to resolve it.
 */
export const sync = Effect.fn("Stack.sync")(function* (
  input: SyncInput = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;

  const output = yield* gh.execute(
    [
      "stack",
      "sync",
      ...(input.prune ? ["--prune"] : []),
      ...retargetArgs(input),
      ...pushArgs(input),
    ],
    options,
  );

  return parseSync(output.stderr);
});

/** Input for {@link rebase}. */
export interface RebaseInput extends RetargetInput {
  /** Branch to rebase around; the checked-out one without it. */
  readonly branch?: string;
  /** Only rebase from the trunk up to the branch (`downstack`), or from it to the top (`upstack`). */
  readonly scope?: "downstack" | "upstack";
  /** False skips fetching and rebasing onto the trunk, only rebasing branches onto each other. */
  readonly trunk?: boolean;
  /** Remote to fetch from. */
  readonly remote?: string;
  /** Keep each commit's author date as its committer date. */
  readonly committerDateIsAuthorDate?: boolean;
}

/**
 * Pull the trunk and rebase each branch onto the one below it. A conflict
 * fails with `conflict` and leaves the rebase paused: resolve and stage the
 * files, then {@link continueRebase}, or {@link abortRebase}.
 */
export const rebase = Effect.fn("Stack.rebase")(function* (
  input: RebaseInput = {},
  options?: GhOptions,
) {
  yield* run(
    [
      "rebase",
      ...(input.scope === undefined ? [] : [`--${input.scope}`]),
      ...(input.trunk === false ? ["--no-trunk"] : []),
      ...(input.remote === undefined ? [] : [`--remote=${input.remote}`]),
      ...(input.committerDateIsAuthorDate
        ? ["--committer-date-is-author-date"]
        : []),
      ...retargetArgs(input),
      ...(input.branch === undefined ? [] : ["--", input.branch]),
    ],
    options,
  );
});

/** Carry on with a paused {@link rebase} once its conflicts are resolved and staged. */
export const continueRebase = Effect.fn("Stack.continueRebase")(function* (
  options?: GhOptions,
) {
  yield* run(["rebase", "--continue"], options);
});

/** Abandon a paused {@link rebase}, restoring every branch. */
export const abortRebase = Effect.fn("Stack.abortRebase")(function* (
  options?: GhOptions,
) {
  yield* run(["rebase", "--abort"], options);
});

/** Input for {@link link}. */
export interface LinkInput extends PushInput {
  /**
   * Branches, pull request numbers or URLs, bottom first. Branches are pushed
   * and get pull requests when they have none. At least two, or one with
   * `stack`.
   */
  readonly items: ReadonlyArray<number | string>;
  /** Add `items` to the top of this stack on GitHub instead of naming its pull requests again. */
  readonly stack?: number;
  /** Base branch of the bottom pull request; the repository's default branch without it. */
  readonly base?: string;
  /** Mark new and existing pull requests ready for review. */
  readonly open?: boolean;
}

/**
 * Create or grow a stack on GitHub without tracking it locally, for branches
 * managed by other tools. Pull requests already in the stack are never
 * removed.
 */
export const link = Effect.fn("Stack.link")(function* (
  input: LinkInput,
  options?: GhOptions,
) {
  yield* run(
    [
      "link",
      ...(input.base === undefined ? [] : [`--base=${input.base}`]),
      ...(input.open ? ["--open"] : []),
      ...pushArgs(input),
      "--",
      ...(input.stack === undefined ? [] : [String(input.stack)]),
      ...input.items.map(String),
    ],
    options,
  );
});

/** Input for {@link merge}. */
export interface MergeInput {
  /**
   * A stack number to merge that whole stack, or a pull request number to
   * merge it and every unmerged one below it; the checked-out branch's whole
   * stack without it. A bare number is tried as a stack first.
   */
  readonly target?: number;
  /** gh-stack reuses the last method without it. A merge queue picks its own. */
  readonly method?: "merge" | "squash" | "rebase";
}

/**
 * Merge pull requests of a stack all at once: if any can't merge, none do.
 * With a merge queue on the base branch, the stack is queued instead.
 * Branch protection can't be bypassed. With `interactive`, gh-stack's wizard
 * lets the user choose how far to merge and confirm.
 */
export const merge = Effect.fn("Stack.merge")(function* (
  input: MergeInput = {},
  options?: InteractiveOptions,
) {
  yield* run(
    [
      "merge",
      ...(options?.interactive ? [] : ["--yes"]),
      ...(input.method === undefined ? [] : [`--merge-method=${input.method}`]),
      ...(input.target === undefined ? [] : ["--", String(input.target)]),
    ],
    options,
  );
});

/** Input for {@link alias}. */
export interface AliasInput {
  /** The alias's name; `gs` without it. */
  readonly name?: string;
  /** Remove the alias instead. */
  readonly remove?: boolean;
}

/** Install, or remove, a wrapper script in `~/.local/bin` that runs `gh stack`. */
export const alias = Effect.fn("Stack.alias")(function* (
  input: AliasInput = {},
  options?: GhOptions,
) {
  yield* run(
    [
      "alias",
      ...(input.remove ? ["--remove"] : []),
      ...(input.name === undefined ? [] : ["--", input.name]),
    ],
    options,
  );
});

/** Open gh-stack's feedback discussion in the browser, with a title when given. */
export const feedback = Effect.fn("Stack.feedback")(function* (
  title?: string,
  options?: GhOptions,
) {
  yield* run(
    ["feedback", ...(title === undefined ? [] : ["--", title])],
    options,
  );
});
