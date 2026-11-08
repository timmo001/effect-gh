import { Effect, Schema } from "effect";
import { Gh, type GhOptions } from "./gh.js";

const GitStatus = Schema.Struct({
  ref: Schema.String,
  ahead: Schema.Int,
  behind: Schema.Int,
  hasUncommittedChanges: Schema.Boolean,
  hasUnpushedChanges: Schema.Boolean,
});

/** A codespace as `gh codespace list` returns it. */
export const ListItem = Schema.Struct({
  name: Schema.String,
  displayName: Schema.String,
  state: Schema.String,
  /** The owner's login. */
  owner: Schema.String,
  /** `owner/name`. */
  repository: Schema.String,
  machineName: Schema.String,
  createdAt: Schema.String,
  lastUsedAt: Schema.String,
  gitStatus: GitStatus,
  /** Only set for a non-production service. */
  vscsTarget: Schema.optionalKey(Schema.String),
});

export interface ListItem extends Schema.Schema.Type<typeof ListItem> {}

/** A codespace as `gh codespace view` returns it. */
export const Codespace = Schema.Struct({
  name: Schema.String,
  displayName: Schema.String,
  state: Schema.String,
  owner: Schema.String,
  repository: Schema.String,
  machineName: Schema.String,
  machineDisplayName: Schema.String,
  createdAt: Schema.String,
  lastUsedAt: Schema.String,
  gitStatus: GitStatus,
  devcontainerPath: Schema.String,
  location: Schema.String,
  idleTimeoutMinutes: Schema.Int,
  prebuild: Schema.Boolean,
});

export interface Codespace extends Schema.Schema.Type<typeof Codespace> {}

/** A forwarded port of a codespace. */
export const Port = Schema.Struct({
  sourcePort: Schema.Int,
  visibility: Schema.String,
  /** Empty without a devcontainer label. */
  label: Schema.String,
  browseUrl: Schema.String,
});

export interface Port extends Schema.Schema.Type<typeof Port> {}

/** The codespace an operation selects, by its name (see {@link list}). */
export interface Target {
  readonly codespace: string;
}

const targetArgs = (target: Target) => ["--codespace", target.codespace];

const fields = (schema: { readonly fields: object }) =>
  Object.keys(schema.fields).join(",");

/** Input for {@link list}. */
export interface ListInput {
  readonly repo?: string;
  /** At most this many codespaces, 30 by default. */
  readonly limit?: number;
  /** List an organisation's codespaces (admins only). */
  readonly org?: string;
  /** With `org`, the user whose codespaces to list. */
  readonly user?: string;
}

/** List the user's codespaces. */
export const list = Effect.fn("Codespace.list")(function* (
  input: ListInput = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "codespace",
      "list",
      ...(input.repo === undefined ? [] : ["--repo", input.repo]),
      ...(input.limit === undefined ? [] : ["--limit", String(input.limit)]),
      ...(input.org === undefined ? [] : ["--org", input.org]),
      ...(input.user === undefined ? [] : ["--user", input.user]),
      "--json",
      fields(ListItem),
    ],
    Schema.Array(ListItem),
    options,
  );
});

/** View a codespace. */
export const view = Effect.fn("Codespace.view")(function* (
  input: Target,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    ["codespace", "view", ...targetArgs(input), "--json", fields(Codespace)],
    Codespace,
    options,
  );
});

/** Input for {@link create}. */
export interface CreateInput {
  /** `owner/name`. */
  readonly repo: string;
  /** The VM's hardware specification, such as `basicLinux32gb`. */
  readonly machine: string;
  readonly branch?: string;
  readonly devcontainerPath?: string;
  readonly displayName?: string;
  /** Allowed inactivity before the codespace stops, such as `30m`. */
  readonly idleTimeout?: string;
  readonly location?: "EastUs" | "SouthEastAsia" | "WestEurope" | "WestUs2";
  /** Time after shutting down before deletion, up to 30 days, such as `72h`. */
  readonly retentionPeriod?: string;
  /** Accept any additional permissions the codespace requests. */
  readonly defaultPermissions?: boolean;
}

/** Create a codespace and return its name. */
export const create = Effect.fn("Codespace.create")(function* (
  input: CreateInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  const output = yield* gh.execute(
    [
      "codespace",
      "create",
      "--repo",
      input.repo,
      "--machine",
      input.machine,
      ...(input.branch === undefined ? [] : ["--branch", input.branch]),
      ...(input.devcontainerPath === undefined
        ? []
        : ["--devcontainer-path", input.devcontainerPath]),
      ...(input.displayName === undefined
        ? []
        : ["--display-name", input.displayName]),
      ...(input.idleTimeout === undefined
        ? []
        : ["--idle-timeout", input.idleTimeout]),
      ...(input.location === undefined ? [] : ["--location", input.location]),
      ...(input.retentionPeriod === undefined
        ? []
        : ["--retention-period", input.retentionPeriod]),
      ...(input.defaultPermissions ? ["--default-permissions"] : []),
    ],
    options,
  );

  return { name: output.stdout.trim().split("\n").at(-1) ?? "" };
});

/** Change a codespace's display name or machine type. */
export const edit = Effect.fn("Codespace.edit")(function* (
  input: Target & {
    readonly displayName?: string;
    readonly machine?: string;
  },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "codespace",
      "edit",
      ...targetArgs(input),
      ...(input.displayName === undefined
        ? []
        : ["--display-name", input.displayName]),
      ...(input.machine === undefined ? [] : ["--machine", input.machine]),
    ],
    options,
  );
});

/** Input for {@link remove}. */
export interface RemoveInput {
  /** One codespace by name. Otherwise set `all`, `days` or `repo`. */
  readonly codespace?: string;
  /** Delete all the user's codespaces. */
  readonly all?: boolean;
  /** Delete codespaces older than this many days. */
  readonly days?: number;
  readonly repo?: string;
  readonly repoOwner?: string;
  /** An organisation (admins only). */
  readonly org?: string;
  /** With `org`, the user whose codespaces to delete. */
  readonly user?: string;
  /** Also delete codespaces with unsaved changes; without it, gh refuses them. */
  readonly force?: boolean;
}

/** Delete codespaces. Ones with unsaved changes need `force`. */
export const remove = Effect.fn("Codespace.remove")(function* (
  input: RemoveInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "codespace",
      "delete",
      ...(input.codespace === undefined
        ? []
        : ["--codespace", input.codespace]),
      ...(input.all ? ["--all"] : []),
      ...(input.days === undefined ? [] : ["--days", String(input.days)]),
      ...(input.repo === undefined ? [] : ["--repo", input.repo]),
      ...(input.repoOwner === undefined
        ? []
        : ["--repo-owner", input.repoOwner]),
      ...(input.org === undefined ? [] : ["--org", input.org]),
      ...(input.user === undefined ? [] : ["--user", input.user]),
      ...(input.force ? ["--force"] : []),
    ],
    options,
  );
});

/** Stop a running codespace. */
export const stop = Effect.fn("Codespace.stop")(function* (
  input: Target & {
    /** An organisation (admins only). */
    readonly org?: string;
    /** With `org`, the codespace's user. */
    readonly user?: string;
  },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "codespace",
      "stop",
      ...targetArgs(input),
      ...(input.org === undefined ? [] : ["--org", input.org]),
      ...(input.user === undefined ? [] : ["--user", input.user]),
    ],
    options,
  );
});

/** Rebuild a codespace's dev container, removing cached images with `full`. */
export const rebuild = Effect.fn("Codespace.rebuild")(function* (
  input: Target & { readonly full?: boolean },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "codespace",
      "rebuild",
      ...targetArgs(input),
      ...(input.full ? ["--full"] : []),
    ],
    options,
  );
});

/** Read a codespace's creation logs. */
export const logs = Effect.fn("Codespace.logs")(function* (
  input: Target,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  const output = yield* gh.execute(
    ["codespace", "logs", ...targetArgs(input)],
    options,
  );

  return output.stdout;
});

/** Input for {@link cp}. */
export interface CpInput extends Target {
  /** Paths to copy. Prefix a codespace path with `remote:`. */
  readonly sources: ReadonlyArray<string>;
  /** The destination, which must be a directory with several sources. */
  readonly destination: string;
  readonly recursive?: boolean;
  /** Expand remote paths in the remote shell. Never use with untrusted paths. */
  readonly expand?: boolean;
}

/** Copy files between the local machine and a codespace. */
export const cp = Effect.fn("Codespace.cp")(function* (
  input: CpInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "codespace",
      "cp",
      ...targetArgs(input),
      ...(input.recursive ? ["--recursive"] : []),
      ...(input.expand ? ["--expand"] : []),
      ...input.sources,
      input.destination,
    ],
    options,
  );
});

/** List a codespace's forwarded ports. */
export const ports = Effect.fn("Codespace.ports")(function* (
  input: Target,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    ["codespace", "ports", ...targetArgs(input), "--json", fields(Port)],
    Schema.Array(Port),
    options,
  );
});

/** Change the visibility of forwarded ports. */
export const portsVisibility = Effect.fn("Codespace.portsVisibility")(
  function* (
    input: Target & {
      readonly ports: ReadonlyArray<{
        readonly port: number;
        readonly visibility: "public" | "private" | "org";
      }>;
    },
    options?: GhOptions,
  ) {
    const gh = yield* Gh;

    yield* gh.execute(
      [
        "codespace",
        "ports",
        "visibility",
        ...targetArgs(input),
        ...input.ports.map(({ port, visibility }) => `${port}:${visibility}`),
      ],
      options,
    );
  },
);
