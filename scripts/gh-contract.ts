import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Layer, Match, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Gh, Release, layer } from "../src/index.js";

/**
 * Snapshot the parts of gh this SDK relies on: the help of every wrapped
 * command and the `--json` fields of those that select fields, plus the help
 * of gh itself and of each command group the SDK wraps, which lists their
 * subcommands. The tooling drift workflow regenerates the snapshot at each gh
 * release so a changed flag or field, or a new command or subcommand, shows up
 * as a diff under `tooling/gh`. `--release <tag>` downloads that cli/cli
 * release and snapshots its gh; `--gh <executable>` snapshots an installed one.
 */
interface Command {
  readonly name: string;
  readonly args: readonly string[];
  readonly json?: boolean;
}

/** gh and the command groups the SDK wraps, whose help lists their commands. */
const groups: readonly Command[] = [
  { name: "gh", args: [] },
  { name: "auth", args: ["auth"] },
  { name: "extension", args: ["extension"] },
  { name: "issue", args: ["issue"] },
  { name: "issue-artifact", args: ["issue", "artifact"] },
  { name: "label", args: ["label"] },
  { name: "pr", args: ["pr"] },
  { name: "release", args: ["release"] },
  { name: "repo", args: ["repo"] },
  { name: "run", args: ["run"] },
  { name: "search", args: ["search"] },
  { name: "workflow", args: ["workflow"] },
];

const commands: readonly Command[] = [
  ...groups,
  { name: "api", args: ["api"] },
  { name: "auth-status", args: ["auth", "status"] },
  { name: "auth-token", args: ["auth", "token"] },
  { name: "extension-install", args: ["extension", "install"] },
  { name: "extension-list", args: ["extension", "list"] },
  { name: "extension-upgrade", args: ["extension", "upgrade"] },
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
  { name: "issue-edit", args: ["issue", "edit"] },
  { name: "issue-list", args: ["issue", "list"], json: true },
  { name: "issue-view", args: ["issue", "view"], json: true },
  { name: "label-create", args: ["label", "create"] },
  { name: "label-delete", args: ["label", "delete"] },
  { name: "pr-checks", args: ["pr", "checks"], json: true },
  { name: "pr-create", args: ["pr", "create"] },
  { name: "pr-diff", args: ["pr", "diff"] },
  { name: "pr-edit", args: ["pr", "edit"] },
  { name: "pr-list", args: ["pr", "list"], json: true },
  { name: "pr-merge", args: ["pr", "merge"] },
  { name: "pr-view", args: ["pr", "view"], json: true },
  { name: "release-create", args: ["release", "create"] },
  { name: "release-download", args: ["release", "download"] },
  { name: "release-edit", args: ["release", "edit"] },
  { name: "release-upload", args: ["release", "upload"] },
  { name: "release-view", args: ["release", "view"], json: true },
  { name: "repo-clone", args: ["repo", "clone"] },
  { name: "repo-read-dir", args: ["repo", "read-dir"], json: true },
  { name: "repo-read-file", args: ["repo", "read-file"], json: true },
  { name: "repo-view", args: ["repo", "view"], json: true },
  { name: "run-list", args: ["run", "list"], json: true },
  { name: "run-rerun", args: ["run", "rerun"] },
  { name: "run-view", args: ["run", "view"], json: true },
  { name: "run-watch", args: ["run", "watch"] },
  { name: "search-code", args: ["search", "code"], json: true },
  { name: "workflow-run", args: ["workflow", "run"] },
];

const usage =
  "Usage: bun scripts/gh-contract.ts [--release <tag> | --gh <executable>] [--output <directory>]";

interface Options {
  readonly executable: string;
  readonly release: string | undefined;
  readonly output: string;
}

const parseOptions = (args: readonly string[]): Options | undefined => {
  let executable = "gh";
  let release: string | undefined;
  let output = "tooling/gh";

  for (let index = 0; index < args.length; index += 2) {
    const value = args.at(index + 1);

    if (value === undefined) return undefined;

    switch (args[index]) {
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

  return { executable, release, output };
};

class ReleaseAssetError extends Schema.TaggedError<ReleaseAssetError>()(
  "ReleaseAssetError",
  { message: Schema.String },
) {}

/** The gh release asset for this machine, and the path of gh inside it. */
const releaseAsset = (tag: string) => {
  const version = tag.replace(/^v/, "");

  const platform = Match.value(process.platform).pipe(
    Match.when("linux", () => "linux" as const),
    Match.when("darwin", () => "macOS" as const),
    Match.orElse(() => undefined),
  );

  const architecture = Match.value(process.arch).pipe(
    Match.when("x64", () => "amd64" as const),
    Match.when("arm64", () => "arm64" as const),
    Match.orElse(() => undefined),
  );

  if (platform === undefined || architecture === undefined) return undefined;

  const directory = `gh_${version}_${platform}_${architecture}`;

  return {
    asset: `${directory}.${platform === "linux" ? "tar.gz" : "zip"}`,
    executable: `${directory}/bin/gh`,
  };
};

/** Download a cli/cli release into a scoped temporary directory and return its gh. */
const downloadRelease = Effect.fn("GhContract.downloadRelease")(function* (
  tag: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const target = releaseAsset(tag);

  if (target === undefined)
    return yield* new ReleaseAssetError({
      message: `No gh release asset for ${process.platform} ${process.arch}`,
    });

  const directory = yield* fs.makeTempDirectoryScoped({
    prefix: "gh-contract-",
  });

  yield* Release.download({
    repo: "cli/cli",
    tag,
    patterns: [target.asset],
    directory,
  });

  const archive = path.join(directory, target.asset);

  const extract = target.asset.endsWith(".zip")
    ? ChildProcess.make("unzip", ["-q", archive, "-d", directory])
    : ChildProcess.make("tar", ["-xzf", archive, "-C", directory]);

  const code = yield* spawner.exitCode(extract);

  if (Number(code) !== 0)
    return yield* new ReleaseAssetError({
      message: `Could not extract ${target.asset} (exit code ${code})`,
    });

  return path.join(directory, target.executable);
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

const section = (args: readonly string[], text: string) =>
  `$ ${["gh", ...args].join(" ")}\n${text.trimEnd()}\n`;

const snapshot = Effect.fn("GhContract.snapshot")(function* (command: Command) {
  const help = yield* capture([...command.args, "--help"]);

  const fields = command.json
    ? yield* capture([...command.args, "--json"])
    : undefined;

  return [
    section([...command.args, "--help"], help),
    ...(fields === undefined
      ? []
      : [section([...command.args, "--json"], fields)]),
  ].join("\n");
});

const writeSnapshots = Effect.fn("GhContract.write")(function* (
  options: Options,
  executable: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* fs.makeDirectory(options.output, { recursive: true });

  for (const command of commands) {
    const file = path.join(options.output, `${command.name}.txt`);

    yield* fs.writeFileString(
      file,
      yield* snapshot(command).pipe(
        Effect.provide(
          ghLayer(executable).pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    );
  }

  yield* Effect.log(
    `Wrote ${commands.length} gh contract snapshots to ${options.output}`,
  );
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
      GH_PROMPT_DISABLED: "1",
      GH_PAGER: "cat",
      NO_COLOR: "1",
      TERM: "dumb",
    },
  });

const program = Effect.gen(function* () {
  const executable =
    options.release === undefined
      ? options.executable
      : yield* downloadRelease(options.release).pipe(
          // The download runs through the installed, authenticated gh.
          Effect.provide(layer().pipe(Layer.provide(NodeServices.layer))),
        );

  yield* writeSnapshots(options, executable);
});

await Effect.runPromise(
  program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
