import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Layer, Match, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Api, Gh, Release, layer } from "../src/index.js";

/**
 * Snapshot the parts of gh this SDK relies on: the help of every wrapped
 * command and the `--json` fields of those that select fields, plus the help
 * of gh itself and of each command group the SDK wraps, which lists their
 * subcommands. Upkeep's drift job flags each new gh release; refreshing the
 * snapshot then shows a changed flag or field, or a new command or subcommand,
 * as a diff under `tooling/gh`. `--release <tag>` downloads that cli/cli
 * release and snapshots its gh; `--gh <executable>` snapshots an installed one.
 *
 * `--tool stack` does the same for the gh-stack extension under
 * `tooling/gh-stack`, from a github/gh-stack release or an installed
 * `gh-stack` binary. Its `view --json` output and exit codes have no help
 * page, so it also snapshots their definitions from the source at that tag.
 */
interface Command {
  readonly name: string;
  readonly args: readonly string[];
  readonly json?: boolean;
}

/** gh and the command groups the SDK wraps, whose help lists their commands. */
const groups: readonly Command[] = [
  { name: "gh", args: [] },
  { name: "agent-task", args: ["agent-task"] },
  { name: "alias", args: ["alias"] },
  { name: "attestation", args: ["attestation"] },
  { name: "auth", args: ["auth"] },
  { name: "cache", args: ["cache"] },
  { name: "codespace", args: ["codespace"] },
  { name: "config", args: ["config"] },
  { name: "discussion", args: ["discussion"] },
  { name: "extension", args: ["extension"] },
  { name: "gist", args: ["gist"] },
  { name: "gpg-key", args: ["gpg-key"] },
  { name: "issue", args: ["issue"] },
  { name: "issue-artifact", args: ["issue", "artifact"] },
  { name: "label", args: ["label"] },
  { name: "org", args: ["org"] },
  { name: "pr", args: ["pr"] },
  { name: "project", args: ["project"] },
  { name: "release", args: ["release"] },
  { name: "repo", args: ["repo"] },
  { name: "repo-autolink", args: ["repo", "autolink"] },
  { name: "repo-deploy-key", args: ["repo", "deploy-key"] },
  { name: "repo-gitignore", args: ["repo", "gitignore"] },
  { name: "repo-license", args: ["repo", "license"] },
  { name: "ruleset", args: ["ruleset"] },
  { name: "run", args: ["run"] },
  { name: "search", args: ["search"] },
  { name: "secret", args: ["secret"] },
  { name: "skill", args: ["skill"] },
  { name: "ssh-key", args: ["ssh-key"] },
  { name: "variable", args: ["variable"] },
  { name: "workflow", args: ["workflow"] },
];

const commands: readonly Command[] = [
  ...groups,
  { name: "agent-task-create", args: ["agent-task", "create"] },
  { name: "agent-task-list", args: ["agent-task", "list"], json: true },
  { name: "agent-task-view", args: ["agent-task", "view"], json: true },
  { name: "alias-delete", args: ["alias", "delete"] },
  { name: "alias-import", args: ["alias", "import"] },
  { name: "alias-list", args: ["alias", "list"] },
  { name: "alias-set", args: ["alias", "set"] },
  { name: "api", args: ["api"] },
  { name: "attestation-download", args: ["attestation", "download"] },
  { name: "attestation-trusted-root", args: ["attestation", "trusted-root"] },
  { name: "attestation-verify", args: ["attestation", "verify"] },
  { name: "auth-login", args: ["auth", "login"] },
  { name: "auth-logout", args: ["auth", "logout"] },
  { name: "auth-refresh", args: ["auth", "refresh"] },
  { name: "auth-setup-git", args: ["auth", "setup-git"] },
  { name: "auth-status", args: ["auth", "status"] },
  { name: "auth-switch", args: ["auth", "switch"] },
  { name: "auth-token", args: ["auth", "token"] },
  { name: "cache-delete", args: ["cache", "delete"] },
  { name: "cache-list", args: ["cache", "list"], json: true },
  { name: "codespace-cp", args: ["codespace", "cp"] },
  { name: "codespace-create", args: ["codespace", "create"] },
  { name: "codespace-delete", args: ["codespace", "delete"] },
  { name: "codespace-edit", args: ["codespace", "edit"] },
  { name: "codespace-list", args: ["codespace", "list"], json: true },
  { name: "codespace-logs", args: ["codespace", "logs"] },
  { name: "codespace-ports", args: ["codespace", "ports"], json: true },
  {
    name: "codespace-ports-visibility",
    args: ["codespace", "ports", "visibility"],
  },
  { name: "codespace-rebuild", args: ["codespace", "rebuild"] },
  { name: "codespace-stop", args: ["codespace", "stop"] },
  { name: "codespace-view", args: ["codespace", "view"], json: true },
  { name: "config-clear-cache", args: ["config", "clear-cache"] },
  { name: "config-get", args: ["config", "get"] },
  { name: "config-list", args: ["config", "list"] },
  { name: "config-set", args: ["config", "set"] },
  { name: "discussion-create", args: ["discussion", "create"] },
  { name: "discussion-edit", args: ["discussion", "edit"] },
  { name: "extension-create", args: ["extension", "create"] },
  { name: "extension-exec", args: ["extension", "exec"] },
  { name: "extension-install", args: ["extension", "install"] },
  { name: "extension-list", args: ["extension", "list"] },
  { name: "extension-remove", args: ["extension", "remove"] },
  { name: "extension-search", args: ["extension", "search"], json: true },
  { name: "extension-upgrade", args: ["extension", "upgrade"] },
  { name: "gist-clone", args: ["gist", "clone"] },
  { name: "gist-create", args: ["gist", "create"] },
  { name: "gist-delete", args: ["gist", "delete"] },
  { name: "gist-edit", args: ["gist", "edit"] },
  { name: "gist-list", args: ["gist", "list"] },
  { name: "gist-rename", args: ["gist", "rename"] },
  { name: "gist-view", args: ["gist", "view"] },
  { name: "gpg-key-add", args: ["gpg-key", "add"] },
  { name: "gpg-key-delete", args: ["gpg-key", "delete"] },
  { name: "gpg-key-list", args: ["gpg-key", "list"] },
  { name: "issue-artifact-create", args: ["issue", "artifact", "create"] },
  { name: "issue-artifact-delete", args: ["issue", "artifact", "delete"] },
  { name: "issue-artifact-download", args: ["issue", "artifact", "download"] },
  { name: "issue-artifact-edit", args: ["issue", "artifact", "edit"] },
  {
    name: "issue-artifact-list",
    args: ["issue", "artifact", "list"],
    json: true,
  },
  {
    name: "issue-artifact-view",
    args: ["issue", "artifact", "view"],
    json: true,
  },
  { name: "issue-close", args: ["issue", "close"] },
  { name: "issue-comment", args: ["issue", "comment"] },
  { name: "issue-create", args: ["issue", "create"] },
  { name: "issue-delete", args: ["issue", "delete"] },
  { name: "issue-develop", args: ["issue", "develop"] },
  { name: "issue-edit", args: ["issue", "edit"] },
  { name: "issue-list", args: ["issue", "list"], json: true },
  { name: "issue-lock", args: ["issue", "lock"] },
  { name: "issue-pin", args: ["issue", "pin"] },
  { name: "issue-reopen", args: ["issue", "reopen"] },
  { name: "issue-status", args: ["issue", "status"], json: true },
  { name: "issue-transfer", args: ["issue", "transfer"] },
  { name: "issue-unlock", args: ["issue", "unlock"] },
  { name: "issue-unpin", args: ["issue", "unpin"] },
  { name: "issue-view", args: ["issue", "view"], json: true },
  { name: "label-clone", args: ["label", "clone"] },
  { name: "label-create", args: ["label", "create"] },
  { name: "label-delete", args: ["label", "delete"] },
  { name: "label-edit", args: ["label", "edit"] },
  { name: "label-list", args: ["label", "list"], json: true },
  { name: "org-list", args: ["org", "list"] },
  { name: "pr-checkout", args: ["pr", "checkout"] },
  { name: "pr-checks", args: ["pr", "checks"], json: true },
  { name: "pr-close", args: ["pr", "close"] },
  { name: "pr-comment", args: ["pr", "comment"] },
  { name: "pr-create", args: ["pr", "create"] },
  { name: "pr-diff", args: ["pr", "diff"] },
  { name: "pr-edit", args: ["pr", "edit"] },
  { name: "pr-list", args: ["pr", "list"], json: true },
  { name: "pr-lock", args: ["pr", "lock"] },
  { name: "pr-merge", args: ["pr", "merge"] },
  { name: "pr-ready", args: ["pr", "ready"] },
  { name: "pr-reopen", args: ["pr", "reopen"] },
  { name: "pr-revert", args: ["pr", "revert"] },
  { name: "pr-review", args: ["pr", "review"] },
  { name: "pr-status", args: ["pr", "status"], json: true },
  { name: "pr-unlock", args: ["pr", "unlock"] },
  { name: "pr-update-branch", args: ["pr", "update-branch"] },
  { name: "pr-view", args: ["pr", "view"], json: true },
  { name: "project-close", args: ["project", "close"] },
  { name: "project-copy", args: ["project", "copy"] },
  { name: "project-create", args: ["project", "create"] },
  { name: "project-delete", args: ["project", "delete"] },
  { name: "project-edit", args: ["project", "edit"] },
  { name: "project-field-create", args: ["project", "field-create"] },
  { name: "project-field-delete", args: ["project", "field-delete"] },
  { name: "project-field-list", args: ["project", "field-list"] },
  { name: "project-item-add", args: ["project", "item-add"] },
  { name: "project-item-archive", args: ["project", "item-archive"] },
  { name: "project-item-create", args: ["project", "item-create"] },
  { name: "project-item-delete", args: ["project", "item-delete"] },
  { name: "project-item-edit", args: ["project", "item-edit"] },
  { name: "project-item-list", args: ["project", "item-list"] },
  { name: "project-link", args: ["project", "link"] },
  { name: "project-list", args: ["project", "list"] },
  { name: "project-mark-template", args: ["project", "mark-template"] },
  { name: "project-unlink", args: ["project", "unlink"] },
  { name: "project-view", args: ["project", "view"] },
  { name: "release-create", args: ["release", "create"] },
  { name: "release-delete", args: ["release", "delete"] },
  { name: "release-delete-asset", args: ["release", "delete-asset"] },
  { name: "release-download", args: ["release", "download"] },
  { name: "release-edit", args: ["release", "edit"] },
  { name: "release-list", args: ["release", "list"], json: true },
  { name: "release-upload", args: ["release", "upload"] },
  { name: "release-verify", args: ["release", "verify"] },
  { name: "release-verify-asset", args: ["release", "verify-asset"] },
  { name: "release-view", args: ["release", "view"], json: true },
  { name: "repo-archive", args: ["repo", "archive"] },
  { name: "repo-autolink-create", args: ["repo", "autolink", "create"] },
  { name: "repo-autolink-delete", args: ["repo", "autolink", "delete"] },
  {
    name: "repo-autolink-list",
    args: ["repo", "autolink", "list"],
    json: true,
  },
  {
    name: "repo-autolink-view",
    args: ["repo", "autolink", "view"],
    json: true,
  },
  { name: "repo-clone", args: ["repo", "clone"] },
  { name: "repo-create", args: ["repo", "create"] },
  { name: "repo-delete", args: ["repo", "delete"] },
  { name: "repo-deploy-key-add", args: ["repo", "deploy-key", "add"] },
  { name: "repo-deploy-key-delete", args: ["repo", "deploy-key", "delete"] },
  {
    name: "repo-deploy-key-list",
    args: ["repo", "deploy-key", "list"],
    json: true,
  },
  { name: "repo-edit", args: ["repo", "edit"] },
  { name: "repo-fork", args: ["repo", "fork"] },
  { name: "repo-gitignore-list", args: ["repo", "gitignore", "list"] },
  { name: "repo-gitignore-view", args: ["repo", "gitignore", "view"] },
  { name: "repo-license-list", args: ["repo", "license", "list"] },
  { name: "repo-license-view", args: ["repo", "license", "view"] },
  { name: "repo-list", args: ["repo", "list"], json: true },
  { name: "repo-read-dir", args: ["repo", "read-dir"], json: true },
  { name: "repo-read-file", args: ["repo", "read-file"], json: true },
  { name: "repo-rename", args: ["repo", "rename"] },
  { name: "repo-set-default", args: ["repo", "set-default"] },
  { name: "repo-sync", args: ["repo", "sync"] },
  { name: "repo-unarchive", args: ["repo", "unarchive"] },
  { name: "repo-view", args: ["repo", "view"], json: true },
  { name: "ruleset-check", args: ["ruleset", "check"] },
  { name: "ruleset-list", args: ["ruleset", "list"] },
  { name: "ruleset-view", args: ["ruleset", "view"] },
  { name: "run-cancel", args: ["run", "cancel"] },
  { name: "run-delete", args: ["run", "delete"] },
  { name: "run-download", args: ["run", "download"] },
  { name: "run-list", args: ["run", "list"], json: true },
  { name: "run-rerun", args: ["run", "rerun"] },
  { name: "run-view", args: ["run", "view"], json: true },
  { name: "run-watch", args: ["run", "watch"] },
  { name: "search-code", args: ["search", "code"], json: true },
  { name: "search-commits", args: ["search", "commits"], json: true },
  { name: "search-issues", args: ["search", "issues"], json: true },
  { name: "search-prs", args: ["search", "prs"], json: true },
  { name: "search-repos", args: ["search", "repos"], json: true },
  { name: "secret-delete", args: ["secret", "delete"] },
  { name: "secret-list", args: ["secret", "list"], json: true },
  { name: "secret-set", args: ["secret", "set"] },
  { name: "skill-install", args: ["skill", "install"] },
  { name: "skill-list", args: ["skill", "list"], json: true },
  { name: "skill-preview", args: ["skill", "preview"] },
  { name: "skill-publish", args: ["skill", "publish"] },
  { name: "skill-search", args: ["skill", "search"], json: true },
  { name: "skill-update", args: ["skill", "update"] },
  { name: "ssh-key-add", args: ["ssh-key", "add"] },
  { name: "ssh-key-delete", args: ["ssh-key", "delete"] },
  { name: "ssh-key-list", args: ["ssh-key", "list"] },
  { name: "status", args: ["status"] },
  { name: "variable-delete", args: ["variable", "delete"] },
  { name: "variable-get", args: ["variable", "get"], json: true },
  { name: "variable-list", args: ["variable", "list"], json: true },
  { name: "variable-set", args: ["variable", "set"] },
  { name: "workflow-disable", args: ["workflow", "disable"] },
  { name: "workflow-enable", args: ["workflow", "enable"] },
  { name: "workflow-list", args: ["workflow", "list"], json: true },
  { name: "workflow-run", args: ["workflow", "run"] },
  { name: "workflow-view", args: ["workflow", "view"] },
];

/** Every gh-stack command, all of which the Stack module wraps. */
const stackCommands: readonly Command[] = [
  { name: "stack", args: [] },
  ...[
    "add",
    "alias",
    "bottom",
    "checkout",
    "down",
    "feedback",
    "init",
    "link",
    "merge",
    "modify",
    "push",
    "rebase",
    "submit",
    "switch",
    "sync",
    "top",
    "trunk",
    "unstack",
    "up",
    "view",
  ].map((name) => ({ name: `stack-${name}`, args: [name] })),
];

/** gh-stack source the Stack module relies on that no help page shows. */
interface SourcePart {
  readonly file: string;
  readonly description: string;
  readonly pattern: RegExp;
}

const stackSource: readonly SourcePart[] = [
  {
    file: "cmd/view.go",
    description: "gh stack view --json output, decoded by Stack.View",
    pattern: /^type viewJSON\w* struct \{[\s\S]*?^\}$/gm,
  },
  {
    file: "cmd/utils.go",
    description: "Exit codes, read by Stack.exitReason",
    pattern: /^\s*Err\w+\s*= &ExitError\{Code: \d+\}.*$/gm,
  },
  {
    file: "cmd/sync.go",
    description: "How sync ends, read by Stack.parseSync",
    pattern: /^.*cfg\.\w+\("(?:Stack synced|Branches synced)"\).*$/gm,
  },
  {
    file: "cmd/utils.go",
    description: "How a diverged sync ends, read by Stack.parseSync",
    pattern: /^.*cfg\.\w+\("Sync aborted[^"]*"\).*$/gm,
  },
];

type Tool = "gh" | "stack";

const usage =
  "Usage: bun scripts/gh-contract.ts [--tool gh|stack] [--release <tag> | --gh <executable>] [--output <directory>]";

interface Options {
  readonly tool: Tool;
  /** gh, or the gh-stack binary with `--tool stack`. */
  readonly executable: string | undefined;
  readonly release: string | undefined;
  readonly output: string;
}

const parseOptions = (args: readonly string[]): Options | undefined => {
  let tool: Tool = "gh";
  let executable: string | undefined;
  let release: string | undefined;
  let output: string | undefined;

  for (let index = 0; index < args.length; index += 2) {
    const value = args.at(index + 1);

    if (value === undefined) return undefined;

    switch (args[index]) {
      case "--tool":
        if (value !== "gh" && value !== "stack") return undefined;
        tool = value;
        break;
      case "--gh":
        executable = value;
        break;
      case "--release":
        release = value;
        break;
      case "--output":
        output = value;
        break;
      default:
        return undefined;
    }
  }

  return {
    tool,
    executable,
    release,
    output: output ?? (tool === "gh" ? "tooling/gh" : "tooling/gh-stack"),
  };
};

class ReleaseAssetError extends Schema.TaggedError<ReleaseAssetError>()(
  "ReleaseAssetError",
  { message: Schema.String },
) {}

/** This machine's platform and architecture as Go release assets name them. */
const target = () => {
  const platform = Match.value(process.platform).pipe(
    Match.when("linux", () => "linux" as const),
    Match.when("darwin", () => "darwin" as const),
    Match.orElse(() => undefined),
  );

  const architecture = Match.value(process.arch).pipe(
    Match.when("x64", () => "amd64" as const),
    Match.when("arm64", () => "arm64" as const),
    Match.orElse(() => undefined),
  );

  return platform === undefined || architecture === undefined
    ? undefined
    : { platform, architecture };
};

/** The gh release asset for this machine, and the path of gh inside it. */
const ghReleaseAsset = (tag: string) => {
  const version = tag.replace(/^v/, "");
  const machine = target();

  if (machine === undefined) return undefined;
  const platform = machine.platform === "darwin" ? "macOS" : machine.platform;
  const directory = `gh_${version}_${platform}_${machine.architecture}`;

  return {
    asset: `${directory}.${platform === "linux" ? "tar.gz" : "zip"}`,
    executable: `${directory}/bin/gh`,
  };
};

const noAsset = (tool: string) =>
  new ReleaseAssetError({
    message: `No ${tool} release asset for ${process.platform} ${process.arch}`,
  });

/** Download a cli/cli release into a scoped temporary directory and return its gh. */
const downloadGh = Effect.fn("GhContract.downloadGh")(function* (tag: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const release = ghReleaseAsset(tag);

  if (release === undefined) return yield* noAsset("gh");

  const directory = yield* fs.makeTempDirectoryScoped({
    prefix: "gh-contract-",
  });

  yield* Release.download({
    repo: "cli/cli",
    tag,
    patterns: [release.asset],
    directory,
  });

  const archive = path.join(directory, release.asset);

  const extract = release.asset.endsWith(".zip")
    ? ChildProcess.make("unzip", ["-q", archive, "-d", directory])
    : ChildProcess.make("tar", ["-xzf", archive, "-C", directory]);

  const code = yield* spawner.exitCode(extract);

  if (Number(code) !== 0)
    return yield* new ReleaseAssetError({
      message: `Could not extract ${release.asset} (exit code ${code})`,
    });

  return path.join(directory, release.executable);
});

/**
 * Download a github/gh-stack release's binary for this machine into a scoped
 * temporary directory and return it. Its assets are bare binaries.
 */
const downloadStack = Effect.fn("GhContract.downloadStack")(function* (
  tag: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const machine = target();

  if (machine === undefined) return yield* noAsset("gh-stack");
  const asset = `${machine.platform}-${machine.architecture}`;

  const directory = yield* fs.makeTempDirectoryScoped({
    prefix: "gh-stack-contract-",
  });

  yield* Release.download({
    repo: "github/gh-stack",
    tag,
    patterns: [asset],
    directory,
  });

  const executable = path.join(directory, asset);

  yield* fs.chmod(executable, 0o755);

  return executable;
});

/** Help exits zero; a bare `--json` lists the fields on stderr and exits one. */
const capture = Effect.fn("GhContract.capture")(function* (
  args: readonly string[],
) {
  const gh = yield* Gh;

  return yield* gh.execute(args).pipe(
    Effect.map(({ stdout, stderr }) => stdout + stderr),
    Effect.catchTag("GhCommandError", (error) =>
      Effect.succeed(error.stdout + error.stderr),
    ),
  );
});

/** How each tool's commands are shown: the gh-stack binary prints its help as `gh stack`. */
const prefixes: Readonly<Record<Tool, readonly string[]>> = {
  gh: ["gh"],
  stack: ["gh", "stack"],
};

const section = (tool: Tool, args: readonly string[], text: string) =>
  `$ ${[...prefixes[tool], ...args].join(" ")}\n${text.trimEnd()}\n`;

const snapshot = Effect.fn("GhContract.snapshot")(function* (
  tool: Tool,
  command: Command,
) {
  const help = yield* capture([...command.args, "--help"]);

  const fields = command.json
    ? yield* capture([...command.args, "--json"])
    : undefined;

  return [
    section(tool, [...command.args, "--help"], help),
    ...(fields === undefined
      ? []
      : [section(tool, [...command.args, "--json"], fields)]),
  ].join("\n");
});

class SourceError extends Schema.TaggedError<SourceError>()("SourceError", {
  message: Schema.String,
}) {}

/**
 * The parts of gh-stack's source at `ref` listed in {@link stackSource}. A
 * part that no longer matches fails the refresh, since the Stack module's
 * reading of it may be wrong too.
 */
const stackSourceSnapshot = Effect.fn("GhContract.stackSource")(function* (
  ref: string,
) {
  const sections: Array<string> = [];

  for (const part of stackSource) {
    const source = yield* Api.text({
      endpoint: `repos/github/gh-stack/contents/${part.file}`,
      method: "GET",
      query: { ref },
      headers: { Accept: "application/vnd.github.raw+json" },
    });

    const matches = source.match(part.pattern);

    if (matches === null)
      return yield* new SourceError({
        message: `${part.file} at ${ref} no longer has: ${part.description}`,
      });

    sections.push(
      `# ${part.file}: ${part.description}\n${[...new Set(matches)].join("\n")}\n`,
    );
  }

  return sections.join("\n");
});

const writeSnapshots = Effect.fn("GhContract.write")(function* (
  options: Options,
  executable: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const list = options.tool === "gh" ? commands : stackCommands;

  yield* fs.makeDirectory(options.output, { recursive: true });

  for (const command of list) {
    const file = path.join(options.output, `${command.name}.txt`);

    yield* fs.writeFileString(
      file,
      yield* snapshot(options.tool, command).pipe(
        Effect.provide(
          ghLayer(executable).pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    );
  }

  yield* Effect.log(
    `Wrote ${list.length} ${options.tool} contract snapshots to ${options.output}`,
  );
});

/** gh-stack's version, as the tag its source is read at. */
const stackTag = Effect.fn("GhContract.stackTag")(function* (
  executable: string,
) {
  const output = yield* capture(["--version"]).pipe(
    Effect.provide(ghLayer(executable).pipe(Layer.provide(NodeServices.layer))),
  );

  const version = /version\s+(\S+)/.exec(output)?.[1];

  if (version === undefined)
    return yield* new SourceError({
      message: `Could not read the gh-stack version from: ${output.trim()}`,
    });

  return `v${version.replace(/^v/, "")}`;
});

const options = parseOptions(process.argv.slice(2));

if (options === undefined) {
  console.error(usage);
  process.exit(2);
}

// Help output must not depend on the runner's gh configuration or terminal.
const ghLayer = (executable: string) =>
  layer({
    executable,
    timeout: "30 seconds",
    env: {
      GH_CONFIG_DIR: `${process.env.TMPDIR ?? "/tmp"}/gh-contract-config`,
      // gh --help lists installed extensions, which live in the data directory.
      XDG_DATA_HOME: `${process.env.TMPDIR ?? "/tmp"}/gh-contract-data`,
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_STACK_NO_UPDATE_NOTIFIER: "1",
      GH_PROMPT_DISABLED: "1",
      GH_PAGER: "cat",
      NO_COLOR: "1",
      TERM: "dumb",
    },
  });

// Downloads and source reads run through the installed, authenticated gh.
const installedGh = layer().pipe(Layer.provide(NodeServices.layer));

const program = Effect.gen(function* () {
  if (options.tool === "gh") {
    const executable =
      options.release === undefined
        ? (options.executable ?? "gh")
        : yield* downloadGh(options.release).pipe(Effect.provide(installedGh));

    return yield* writeSnapshots(options, executable);
  }

  const executable =
    options.release === undefined
      ? (options.executable ?? "gh-stack")
      : yield* downloadStack(options.release).pipe(Effect.provide(installedGh));

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tag = options.release ?? (yield* stackTag(executable));

  // Read first, so source that no longer matches leaves the snapshot alone.
  const source = yield* stackSourceSnapshot(tag).pipe(
    Effect.provide(installedGh),
  );

  yield* writeSnapshots(options, executable);
  yield* fs.writeFileString(path.join(options.output, "source.txt"), source);
});

await Effect.runPromise(
  program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
