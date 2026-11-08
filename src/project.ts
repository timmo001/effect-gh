import { Effect, Schema } from "effect";
import { Gh, type GhOptions } from "./gh.js";

/** A project as `gh project ... --format json` returns it. */
export const Project = Schema.Struct({
  number: Schema.Int,
  url: Schema.String,
  shortDescription: Schema.String,
  public: Schema.Boolean,
  closed: Schema.Boolean,
  title: Schema.String,
  id: Schema.String,
  readme: Schema.String,
  items: Schema.Struct({ totalCount: Schema.Int }),
  fields: Schema.Struct({ totalCount: Schema.Int }),
  owner: Schema.Struct({ type: Schema.String, login: Schema.String }),
});

export interface Project extends Schema.Schema.Type<typeof Project> {}

/** The result of {@link list}. */
export const Projects = Schema.Struct({
  projects: Schema.Array(Project),
  totalCount: Schema.Int,
});

export interface Projects extends Schema.Schema.Type<typeof Projects> {}

/** A project field, with its options for a single select field. */
export const Field = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** The GraphQL type, such as `ProjectV2Field` or `ProjectV2SingleSelectField`. */
  type: Schema.String,
  options: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  ),
});

export interface Field extends Schema.Schema.Type<typeof Field> {}

/** The result of {@link fieldList}. */
export const Fields = Schema.Struct({
  fields: Schema.Array(Field),
  totalCount: Schema.Int,
});

export interface Fields extends Schema.Schema.Type<typeof Fields> {}

/** A project item as the item commands return it. Draft issues have no `url`. */
export const Item = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  body: Schema.String,
  /** `Issue`, `PullRequest` or `DraftIssue`. */
  type: Schema.String,
  url: Schema.optionalKey(Schema.String),
});

export interface Item extends Schema.Schema.Type<typeof Item> {}

/** The item {@link itemEdit} returns. A draft issue edit may omit the `id`. */
export const EditedItem = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  title: Schema.String,
  body: Schema.String,
  type: Schema.String,
  url: Schema.optionalKey(Schema.String),
});

export interface EditedItem extends Schema.Schema.Type<typeof EditedItem> {}

/** The content of an item in {@link itemList}. Its field values are not decoded. */
export const ItemContent = Schema.Struct({
  type: Schema.String,
  title: Schema.String,
  body: Schema.String,
  id: Schema.optionalKey(Schema.String),
  number: Schema.optionalKey(Schema.Int),
  repository: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
});

export interface ItemContent extends Schema.Schema.Type<typeof ItemContent> {}

/** An item as `gh project item-list` returns it; a field value is not decoded. */
export const ListItem = Schema.Struct({
  id: Schema.String,
  content: Schema.NullOr(ItemContent),
});

export interface ListItem extends Schema.Schema.Type<typeof ListItem> {}

/** The result of {@link itemList}. */
export const ListItems = Schema.Struct({
  items: Schema.Array(ListItem),
  totalCount: Schema.Int,
});

export interface ListItems extends Schema.Schema.Type<typeof ListItems> {}

/** The project an operation selects. `owner` is a login, or `@me` for the current user. */
export interface Target {
  readonly number: number;
  readonly owner?: string;
}

const ownerArgs = (owner: string | undefined) =>
  owner === undefined ? [] : ["--owner", owner];

const targetArgs = (target: Target) => [
  String(target.number),
  ...ownerArgs(target.owner),
];

const jsonFormat = ["--format", "json"];

/** View a project. */
export const view = Effect.fn("Project.view")(function* (
  input: Target,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    ["project", "view", ...targetArgs(input), ...jsonFormat],
    Project,
    options,
  );
});

/** Input for {@link list}. */
export interface ListInput {
  readonly owner?: string;
  /** At most this many projects, 30 by default. */
  readonly limit?: number;
  readonly closed?: boolean;
}

/** List the projects of an owner, the current user's by default. */
export const list = Effect.fn("Project.list")(function* (
  input: ListInput = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "project",
      "list",
      ...ownerArgs(input.owner),
      ...(input.limit === undefined ? [] : ["--limit", String(input.limit)]),
      ...(input.closed ? ["--closed"] : []),
      ...jsonFormat,
    ],
    Projects,
    options,
  );
});

/** Create a project. */
export const create = Effect.fn("Project.create")(function* (
  input: { readonly title: string; readonly owner?: string },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "project",
      "create",
      "--title",
      input.title,
      ...ownerArgs(input.owner),
      ...jsonFormat,
    ],
    Project,
    options,
  );
});

/** Input for {@link copy}. */
export interface CopyInput {
  readonly number: number;
  readonly title: string;
  readonly sourceOwner?: string;
  readonly targetOwner?: string;
  /** Include draft issues. */
  readonly drafts?: boolean;
}

/** Copy a project and return the new one. */
export const copy = Effect.fn("Project.copy")(function* (
  input: CopyInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "project",
      "copy",
      String(input.number),
      "--title",
      input.title,
      ...(input.sourceOwner === undefined
        ? []
        : ["--source-owner", input.sourceOwner]),
      ...(input.targetOwner === undefined
        ? []
        : ["--target-owner", input.targetOwner]),
      ...(input.drafts ? ["--drafts"] : []),
      ...jsonFormat,
    ],
    Project,
    options,
  );
});

/** Input for {@link edit}. */
export interface EditInput extends Target {
  readonly title?: string;
  readonly description?: string;
  readonly readme?: string;
  readonly visibility?: "PUBLIC" | "PRIVATE";
}

/** Change a project. */
export const edit = Effect.fn("Project.edit")(function* (
  input: EditInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "project",
      "edit",
      ...targetArgs(input),
      ...(input.title === undefined ? [] : ["--title", input.title]),
      ...(input.description === undefined
        ? []
        : ["--description", input.description]),
      ...(input.readme === undefined ? [] : ["--readme", input.readme]),
      ...(input.visibility === undefined
        ? []
        : ["--visibility", input.visibility]),
      ...jsonFormat,
    ],
    Project,
    options,
  );
});

/** Close a project, or reopen it with `undo`. */
export const close = Effect.fn("Project.close")(function* (
  input: Target & { readonly undo?: boolean },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "project",
      "close",
      ...targetArgs(input),
      ...(input.undo ? ["--undo"] : []),
      ...jsonFormat,
    ],
    Project,
    options,
  );
});

/** Delete a project. */
export const remove = Effect.fn("Project.remove")(function* (
  input: Target,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    ["project", "delete", ...targetArgs(input), ...jsonFormat],
    Project,
    options,
  );
});

/** Mark an organisation's project as a template, or unmark it with `undo`. */
export const markTemplate = Effect.fn("Project.markTemplate")(function* (
  input: Target & { readonly undo?: boolean },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "project",
      "mark-template",
      ...targetArgs(input),
      ...(input.undo ? ["--undo"] : []),
      ...jsonFormat,
    ],
    Project,
    options,
  );
});

/** Input for {@link link} and {@link unlink}. */
export interface LinkInput extends Target {
  /** `owner/name`. The working directory's repository when neither `repo` nor `team` is set. */
  readonly repo?: string;
  readonly team?: string;
}

const linkArgs = (command: string, input: LinkInput) => [
  "project",
  command,
  ...targetArgs(input),
  ...(input.repo === undefined ? [] : ["--repo", input.repo]),
  ...(input.team === undefined ? [] : ["--team", input.team]),
];

/** Link a project to a repository or a team. */
export const link = Effect.fn("Project.link")(function* (
  input: LinkInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(linkArgs("link", input), options);
});

/** Unlink a project from a repository or a team. */
export const unlink = Effect.fn("Project.unlink")(function* (
  input: LinkInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(linkArgs("unlink", input), options);
});

/** Input for {@link fieldCreate}. */
export interface FieldCreateInput extends Target {
  readonly name: string;
  readonly dataType: "TEXT" | "SINGLE_SELECT" | "DATE" | "NUMBER";
  /** The options of a `SINGLE_SELECT` field. */
  readonly singleSelectOptions?: ReadonlyArray<string>;
}

/** Create a field in a project. */
export const fieldCreate = Effect.fn("Project.fieldCreate")(function* (
  input: FieldCreateInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "project",
      "field-create",
      ...targetArgs(input),
      "--name",
      input.name,
      "--data-type",
      input.dataType,
      ...(input.singleSelectOptions === undefined
        ? []
        : ["--single-select-options", input.singleSelectOptions.join(",")]),
      ...jsonFormat,
    ],
    Field,
    options,
  );
});

/** Delete a field by its ID. */
export const fieldDelete = Effect.fn("Project.fieldDelete")(function* (
  input: { readonly id: string },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    ["project", "field-delete", "--id", input.id, ...jsonFormat],
    Field,
    options,
  );
});

/** List the fields of a project. */
export const fieldList = Effect.fn("Project.fieldList")(function* (
  input: Target & {
    /** At most this many fields, 30 by default. */
    readonly limit?: number;
  },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "project",
      "field-list",
      ...targetArgs(input),
      ...(input.limit === undefined ? [] : ["--limit", String(input.limit)]),
      ...jsonFormat,
    ],
    Fields,
    options,
  );
});

/** Add an issue or pull request to a project by its URL. */
export const itemAdd = Effect.fn("Project.itemAdd")(function* (
  input: Target & { readonly url: string },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "project",
      "item-add",
      ...targetArgs(input),
      "--url",
      input.url,
      ...jsonFormat,
    ],
    Item,
    options,
  );
});

/** Archive an item by its ID, or unarchive it with `undo`. */
export const itemArchive = Effect.fn("Project.itemArchive")(function* (
  input: Target & { readonly id: string; readonly undo?: boolean },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "project",
      "item-archive",
      ...targetArgs(input),
      "--id",
      input.id,
      ...(input.undo ? ["--undo"] : []),
      ...jsonFormat,
    ],
    Item,
    options,
  );
});

/** Create a draft issue item in a project. */
export const itemCreate = Effect.fn("Project.itemCreate")(function* (
  input: Target & { readonly title: string; readonly body?: string },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "project",
      "item-create",
      ...targetArgs(input),
      "--title",
      input.title,
      ...(input.body === undefined ? [] : ["--body", input.body]),
      ...jsonFormat,
    ],
    Item,
    options,
  );
});

/** Delete an item by its ID and return the ID gh reports. */
export const itemDelete = Effect.fn("Project.itemDelete")(function* (
  input: Target & { readonly id: string },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "project",
      "item-delete",
      ...targetArgs(input),
      "--id",
      input.id,
      ...jsonFormat,
    ],
    Schema.Struct({ id: Schema.String }),
    options,
  );
});

/**
 * Input for {@link itemEdit}. Select the item and field by `url` and `field`
 * with the project `number`, or by `id`, `fieldId` and `projectId`. Set at most
 * one value, or `clear` it. `title` and `body` edit a draft issue.
 */
export interface ItemEditInput {
  /** The project number, for selecting by name. */
  readonly number?: number;
  readonly owner?: string;
  /** The item's issue or pull request URL. */
  readonly url?: string;
  /** The item's node ID. */
  readonly id?: string;
  readonly field?: string;
  readonly fieldId?: string;
  readonly projectId?: string;
  /** The option name of a single select field, or text for another field named by `field`. */
  readonly value?: string;
  readonly text?: string;
  readonly numberValue?: number;
  /** `YYYY-MM-DD`. */
  readonly date?: string;
  readonly singleSelectOptionId?: string;
  readonly iterationId?: string;
  /** Remove the field's value. */
  readonly clear?: boolean;
  readonly title?: string;
  readonly body?: string;
}

/** Edit a draft issue or set or clear an item's field value. */
export const itemEdit = Effect.fn("Project.itemEdit")(function* (
  input: ItemEditInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  const flag = (name: string, value: string | undefined) =>
    value === undefined ? [] : [name, value];

  return yield* gh.json(
    [
      "project",
      "item-edit",
      ...(input.number === undefined ? [] : [String(input.number)]),
      ...ownerArgs(input.owner),
      ...flag("--url", input.url),
      ...flag("--id", input.id),
      ...flag("--field", input.field),
      ...flag("--field-id", input.fieldId),
      ...flag("--project-id", input.projectId),
      ...flag("--value", input.value),
      ...flag("--text", input.text),
      ...flag(
        "--number",
        input.numberValue === undefined ? undefined : String(input.numberValue),
      ),
      ...flag("--date", input.date),
      ...flag("--single-select-option-id", input.singleSelectOptionId),
      ...flag("--iteration-id", input.iterationId),
      ...(input.clear ? ["--clear"] : []),
      ...flag("--title", input.title),
      ...flag("--body", input.body),
      ...jsonFormat,
    ],
    EditedItem,
    options,
  );
});

/** Input for {@link itemList}. */
export interface ItemListInput extends Target {
  /** At most this many items, 30 by default. */
  readonly limit?: number;
  /** A Projects filter, such as `assignee:octocat -status:Done`. */
  readonly query?: string;
}

/** List the items of a project. */
export const itemList = Effect.fn("Project.itemList")(function* (
  input: ItemListInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "project",
      "item-list",
      ...targetArgs(input),
      ...(input.limit === undefined ? [] : ["--limit", String(input.limit)]),
      ...(input.query === undefined ? [] : ["--query", input.query]),
      ...jsonFormat,
    ],
    ListItems,
    options,
  );
});
