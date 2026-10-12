import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Layer, Path } from "effect";
import { Gh, layer } from "../src/index.js";

/**
 * Snapshot the parts of gh this SDK relies on: the help of every wrapped
 * command and the `--json` fields of those that select fields. The tooling
 * drift workflow regenerates the snapshot at each gh release so a changed
 * flag or field shows up as a diff under `tooling/gh`.
 */
interface Command {
  readonly name: string;
  readonly args: readonly string[];
  readonly json?: boolean;
}

const commands: readonly Command[] = [
  { name: "api", args: ["api"] },
  { name: "auth-status", args: ["auth", "status"] },
  { name: "auth-token", args: ["auth", "token"] },
  { name: "extension-install", args: ["extension", "install"] },
  { name: "extension-list", args: ["extension", "list"] },
  { name: "extension-upgrade", args: ["extension", "upgrade"] },
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
  { name: "repo-view", args: ["repo", "view"], json: true },
  { name: "run-list", args: ["run", "list"], json: true },
  { name: "run-view", args: ["run", "view"], json: true },
  { name: "run-watch", args: ["run", "watch"] },
  { name: "search-code", args: ["search", "code"], json: true },
  { name: "workflow-run", args: ["workflow", "run"] },
];

const usage =
  "Usage: bun scripts/gh-contract.ts [--gh <executable>] [--output <directory>]";

interface Options {
  readonly executable: string;
  readonly output: string;
}

const parseOptions = (args: readonly string[]): Options | undefined => {
  let executable = "gh";
  let output = "tooling/gh";

  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];

    if (value === undefined) return undefined;

    switch (args[index]) {
      case "--gh":
        executable = value;
        break;
      case "--output":
        output = value;
        break;
      default:
        return undefined;
    }
  }

  return { executable, output };
};

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
  `$ gh ${args.join(" ")}\n${text.trimEnd()}\n`;

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
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* fs.makeDirectory(options.output, { recursive: true });

  for (const command of commands) {
    const file = path.join(options.output, `${command.name}.txt`);
    yield* fs.writeFileString(file, yield* snapshot(command));
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
const ghLayer = layer({
  executable: options.executable,
  timeout: "30 seconds",
  env: {
    GH_CONFIG_DIR: `${process.env.TMPDIR ?? "/tmp"}/gh-contract-config`,
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_PROMPT_DISABLED: "1",
    GH_PAGER: "cat",
    NO_COLOR: "1",
    TERM: "dumb",
  },
}).pipe(Layer.provide(NodeServices.layer));

await Effect.runPromise(
  writeSnapshots(options).pipe(Effect.provide([ghLayer, NodeServices.layer])),
);
