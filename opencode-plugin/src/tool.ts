import { Tool } from "@opencode/schema/tool";
import {
  DateTime,
  type Duration,
  Effect,
  JsonSchema,
  Option,
  Predicate,
  Result,
  Schema,
  SchemaIssue,
  SchemaParser,
  StandardSchema,
} from "effect";

/** Whether a tool only reads state or changes something. */
export type ToolAccess = "read" | "write";

/** Tool input as JSON, before each tool decodes it with its own schema. */
export const ToolInput = Schema.Record(Schema.String, Schema.Json);

/** Tool input as JSON, before each tool decodes it with its own schema. */
export type ToolInput = typeof ToolInput.Type;

/** Reject keys a tool doesn't take, so a misspelt option fails instead of being dropped. */
export const strictInput = { onExcessProperty: "error" } as const;

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

const safeIntegerBounds = new Map([
  ["minimum", Number.MIN_SAFE_INTEGER],
  ["maximum", Number.MAX_SAFE_INTEGER],
]);

const isJsonSchema = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

/** A tool that takes no input: Effect's `Struct({})` accepts any keys, so this rejects them all. */
const NoInput = Schema.Record(Schema.String, Schema.Never);

// Effect adds the safe-integer range to every Schema.Int; drop it as OpenCode does, so the
// catalogue's signatures stay the same.
const dropSafeIntegerBounds = (
  schema: JsonSchema.JsonSchema,
): JsonSchema.JsonSchema => {
  const integer = schema.type === "integer";

  // oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns
  const nested = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(nested)
      : isJsonSchema(value)
        ? dropSafeIntegerBounds(value)
        : value;

  return Object.fromEntries(
    Object.entries(schema)
      .filter(
        ([key, value]) => !integer || safeIntegerBounds.get(key) !== value,
      )
      .map(([key, value]) => [key, nested(value)]),
  );
};

const jsonSchemaOf = (schema: Schema.Top): JsonSchema.JsonSchema => {
  const document = Schema.toJsonSchemaDocument(schema, strictInput);

  return dropSafeIntegerBounds(
    Object.keys(document.definitions).length === 0
      ? document.schema
      : { ...document.schema, $defs: document.definitions },
  );
};

/**
 * Wrap a tool's input schema so OpenCode rejects keys the tool doesn't take.
 * OpenCode decodes plugin tool input with Effect's default, which strips
 * unknown keys even though the JSON Schema it shows has
 * `additionalProperties: false`, so a misspelt option was dropped without a
 * word. A Standard Schema gets the raw input instead: this decodes it strictly
 * against the same schema and, when it passes, hands it on unchanged for the
 * tool to decode.
 */
export const strictToolInput = (
  input: Schema.Codec<unknown>,
): Tool.ValueSchema => {
  const json = jsonSchemaOf(input);
  const { not, ...rest } = json;

  // Effect describes an empty struct as anything but null; OpenCode shows it as an empty object.
  const empty =
    isJsonSchema(not) && not.type === "null" && Object.keys(not).length === 1;

  const shown: JsonSchema.JsonSchema = empty
    ? { ...rest, type: "object", properties: {}, additionalProperties: false }
    : json;

  const decode = SchemaParser.decodeUnknownResult(empty ? NoInput : input, {
    ...strictInput,
    errors: "all",
  });

  const schema: StandardSchema.StandardSchemaV1 &
    StandardSchema.StandardJSONSchemaV1 = {
    "~standard": {
      version: 1,
      vendor: "effect-gh",
      validate: (value) =>
        Result.match(decode(value), {
          onFailure: formatIssue,
          onSuccess: () => ({ value }),
        }),
      jsonSchema: { input: () => shown, output: () => shown },
    },
  };

  return schema;
};

/** What a tool call does, prepared before the permission check. */
export interface PreparedCall {
  /** The call as the permission prompt shows it. */
  readonly summary: string;
  /** A pattern appended to the tool id as the permission resource, so "always allow" covers calls of the same shape. */
  readonly resource?: string | undefined;
  /** This call's access, when the tool's depends on its input, such as an API method. */
  readonly access?: ToolAccess | undefined;
  readonly run: Effect.Effect<unknown, Tool.Error>;
}

/** One SDK operation exposed as a Code Mode tool. */
export interface ClientTool {
  readonly name: string;
  readonly description: string;
  readonly access: ToolAccess;
  readonly pinned: boolean;
  readonly timeout: Duration.Input;
  readonly input: Schema.Codec<unknown>;
  readonly prepare: (
    input: ToolInput,
    directory: string,
  ) => Effect.Effect<PreparedCall, Tool.Error>;
}

const WithMessage = Schema.Struct({ message: Schema.NonEmptyString });

/** Map any failure to a `Tool.Error` carrying its message. */
export const toToolError = (cause: unknown) =>
  cause instanceof Tool.Error
    ? cause
    : new Tool.Error({
        message: Option.match(Schema.decodeUnknownOption(WithMessage)(cause), {
          onNone: () => String(cause),
          onSome: ({ message }) => message,
        }),
        error: cause,
      });

/**
 * Turn an SDK result into plain JSON for the tool output: options become their
 * value or null, and dates and date-times ISO strings, so decoded models read
 * the way their wire format does. Results are already decoded by their own
 * schemas; this only reshapes them for output.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns
export const plain = (value: unknown): unknown => {
  if (Option.isOption(value))
    return Option.isSome(value) ? plain(value.value) : null;

  if (value instanceof Date) return value.toISOString();

  if (DateTime.isDateTime(value)) return DateTime.formatIso(value);

  if (Predicate.isBigInt(value)) return value.toString();

  if (Array.isArray(value)) return value.map(plain);

  if (value instanceof Map)
    return Object.fromEntries(
      [...value].map(([key, item]) => [String(key), plain(item)]),
    );

  if (Predicate.isObject(value)) {
    const entries = Object.entries(value).filter(
      ([key]) => !key.startsWith("~"),
    );

    return Object.fromEntries(entries.map(([key, item]) => [key, plain(item)]));
  }

  return value;
};

/** The last lines of a command's output, for error messages. */
export const tailLines = (text: string) =>
  text.trim().split("\n").slice(-20).join("\n");
