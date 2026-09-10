import { expect, test } from "bun:test";
import {
  Context,
  Effect,
  Layer,
  Schema,
  SchemaTransformation,
  Sink,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as Api from "../src/api.js";
import { GhDecodeError, type GhError } from "../src/errors.js";
import { Gh, layer } from "../src/gh.js";
import { fakeSpawner, textStream } from "./helpers.js";

const firstCommand = (commands: ReadonlyArray<ChildProcess.Command>) => {
  const command = commands[0];
  if (command?._tag !== "StandardCommand")
    throw new Error("Expected a standard command");
  return command;
};

test("raw sends an explicit method, JSON stdin, literal headers and inherited Gh options", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let stdin = "";
      const fake = yield* fakeSpawner({
        stdout: textStream("plain response"),
        stderr: textStream("diagnostic"),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.sync(() => {
            stdin += new TextDecoder().decode(chunk);
          }),
        ),
      });
      const body = {
        title: "@private-file",
        enabled: false,
        count: 3,
        nested: [null, "{owner}"],
      };
      const request = Api.raw({
        endpoint: "repos/{owner}/{repo}/issues",
        method: "POST",
        hostname: "git.example.test",
        headers: { Accept: "application/vnd.github+json", "X-Value": "--jq ." },
        query: { title: "@private-file" },
        body,
        options: { cwd: "/override" },
      });
      expect(fake.commands).toHaveLength(0);
      expect(
        yield* request.pipe(
          Effect.provide(
            layer({
              executable: "custom-gh",
              cwd: "/default",
              env: { GH_TOKEN: "fixture" },
              stdin: "inherited body",
            }).pipe(Layer.provide(fake.layer)),
          ),
        ),
      ).toEqual({
        stdout: "plain response",
        stderr: "diagnostic",
        exitCode: 0,
      });
      expect(stdin).toBe(JSON.stringify(body));
      const command = firstCommand(fake.commands);
      expect(command.command).toBe("custom-gh");
      expect(command.args).toEqual([
        "api",
        "--method",
        "POST",
        "--hostname=git.example.test",
        "--header=Accept: application/vnd.github+json",
        "--header=X-Value: --jq .",
        "--input",
        "-",
        "--",
        "repos/{owner}/{repo}/issues?title=%40private-file",
      ]);
      expect(command.options).toMatchObject({
        cwd: "/override",
        stdin: "pipe",
        env: { GH_TOKEN: "fixture" },
      });
      expect(fake.releases()).toBe(1);
    }),
  );
});

test.each([...Api.Method.literals])(
  "raw preserves explicit %s and disables inherited stdin for empty responses",
  async (method) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fake = yield* fakeSpawner();
        const output = yield* Api.raw({ endpoint: "repos/o/r", method }).pipe(
          Effect.provide(
            layer({ stdin: "do not send" }).pipe(Layer.provide(fake.layer)),
          ),
        );
        expect(output).toEqual({ stdout: "", stderr: "", exitCode: 0 });
        const command = firstCommand(fake.commands);
        expect(command.args).toEqual([
          "api",
          "--method",
          method,
          "--",
          "repos/o/r",
        ]);
        expect(command.options.stdin).toBe("ignore");
      }),
    );
  },
);

test.each([
  ["search/issues", "search/issues?"],
  ["repos/o/r&", "repos/o/r&?"],
  ["search/issues?existing=1", "search/issues?existing=1&"],
  ["search/issues?", "search/issues?"],
  ["search/issues?existing=1&", "search/issues?existing=1&"],
  ["--include", "--include?"],
])("query values are encoded literally on %s", async (endpoint, prefix) => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner();
      yield* Api.raw({
        endpoint,
        method: "GET",
        query: {
          "q&x": "@file {owner} +&=# 世界",
          labels: ["true", "null"],
          page: 2,
          archived: false,
        },
      }).pipe(Effect.provide(layer().pipe(Layer.provide(fake.layer))));
      expect(firstCommand(fake.commands).args).toEqual([
        "api",
        "--method",
        "GET",
        "--",
        `${prefix}q%26x=%40file%20%7Bowner%7D%20%2B%26%3D%23%20%E4%B8%96%E7%95%8C&labels=true&labels=null&page=2&archived=false`,
      ]);
    }),
  );
});

test("query is inserted before fragments and empty arrays add no parameters", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner();
      yield* Api.raw({
        endpoint: "search/issues?existing=1#fragment?",
        method: "GET",
        query: { q: "x", omit: [] },
      }).pipe(Effect.provide(layer().pipe(Layer.provide(fake.layer))));
      expect(firstCommand(fake.commands).args).toEqual([
        "api",
        "--method",
        "GET",
        "--",
        "search/issues?existing=1&q=x#fragment?",
      ]);
    }),
  );
});

test("null is an explicit JSON body", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let stdin = "";
      const fake = yield* fakeSpawner({
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.sync(() => {
            stdin += new TextDecoder().decode(chunk);
          }),
        ),
      });
      yield* Api.raw({ endpoint: "endpoint", method: "PUT", body: null }).pipe(
        Effect.provide(layer().pipe(Layer.provide(fake.layer))),
      );
      expect(stdin).toBe("null");
      expect(firstCommand(fake.commands).args).toContain("--input");
    }),
  );
});

test.each(["not JSON", '{"id":"wrong"}', ""])(
  "json rejects malformed, mismatched or empty output: %s",
  async (stdout) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fake = yield* fakeSpawner({ stdout: textStream(stdout) });
        const error = yield* Api.json(
          { endpoint: "endpoint", method: "GET" },
          Schema.Struct({ id: Schema.Int }),
        ).pipe(
          Effect.provide(layer().pipe(Layer.provide(fake.layer))),
          Effect.flip,
        );
        expect(error).toBeInstanceOf(GhDecodeError);
        expect(fake.commands).toHaveLength(1);
      }),
    );
  },
);

test("json decodes a mutation response", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner({ stdout: textStream('{"id":42}') });
      expect(
        yield* Api.json(
          { endpoint: "endpoint", method: "PATCH", body: { title: "updated" } },
          Schema.Struct({ id: Schema.Int }),
        ).pipe(Effect.provide(layer().pipe(Layer.provide(fake.layer)))),
      ).toEqual({ id: 42 });
      expect(firstCommand(fake.commands).args).toEqual([
        "api",
        "--method",
        "PATCH",
        "--input",
        "-",
        "--",
        "endpoint",
      ]);
    }),
  );
});

test("pages preserves arrays of records as separate pages", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const output = [[{ id: 1 }, { id: 2 }], [{ id: 3 }], []];
      const fake = yield* fakeSpawner({
        stdout: textStream(JSON.stringify(output)),
      });
      const result = yield* Api.pages(
        { endpoint: "repos/o/r/issues", method: "GET", query: { per_page: 2 } },
        Schema.Array(Schema.Struct({ id: Schema.Int })),
      ).pipe(
        Effect.provide(
          layer({ stdin: "ignored" }).pipe(Layer.provide(fake.layer)),
        ),
      );
      expect(result).toEqual(output);
      expect(firstCommand(fake.commands).args).toEqual([
        "api",
        "--method",
        "GET",
        "--paginate",
        "--slurp",
        "--",
        "repos/o/r/issues?per_page=2",
      ]);
      expect(firstCommand(fake.commands).options.stdin).toBe("ignore");
    }),
  );
});

test("pages preserves object envelopes and rejects an invalid page", async () => {
  const page = Schema.Struct({
    total_count: Schema.Int,
    items: Schema.Array(Schema.Struct({ id: Schema.Int })),
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const output = [
        { total_count: 2, items: [{ id: 1 }] },
        { total_count: 2, items: [{ id: 2 }] },
      ];
      const fake = yield* fakeSpawner({
        stdout: textStream(JSON.stringify(output)),
      });
      expect(
        yield* Api.pages(
          { endpoint: "search/issues", method: "GET" },
          page,
        ).pipe(Effect.provide(layer().pipe(Layer.provide(fake.layer)))),
      ).toEqual(output);
      const invalid = yield* fakeSpawner({
        stdout: textStream('[{"total_count":2,"items":[]},{"items":[]}]'),
      });
      expect(
        yield* Api.pages(
          { endpoint: "search/issues", method: "GET" },
          page,
        ).pipe(
          Effect.provide(layer().pipe(Layer.provide(invalid.layer))),
          Effect.flip,
        ),
      ).toBeInstanceOf(GhDecodeError);
    }),
  );
});

test("json and pages preserve schema decoding service requirements", async () => {
  class Prefix extends Context.Service<Prefix, { readonly value: string }>()(
    "test/api/Prefix",
  ) {}
  const schema = Schema.String.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformEffect({
        decode: (value) => Effect.map(Prefix, (prefix) => prefix.value + value),
        encode: (value) => Effect.succeed(value),
      }),
    ),
  );
  const single: Effect.Effect<string, GhError, Gh | Prefix> = Api.json(
    { endpoint: "endpoint", method: "GET" },
    schema,
  );
  const multiple: Effect.Effect<
    ReadonlyArray<string>,
    GhError,
    Gh | Prefix
  > = Api.pages({ endpoint: "endpoint", method: "GET" }, schema);
  await Effect.runPromise(
    Effect.gen(function* () {
      const one = yield* fakeSpawner({ stdout: textStream('"one"') });
      const many = yield* fakeSpawner({ stdout: textStream('["one","two"]') });
      expect(
        yield* single.pipe(
          Effect.provide(layer().pipe(Layer.provide(one.layer))),
        ),
      ).toBe("prefix-one");
      expect(
        yield* multiple.pipe(
          Effect.provide(layer().pipe(Layer.provide(many.layer))),
        ),
      ).toEqual(["prefix-one", "prefix-two"]);
    }).pipe(Effect.provideService(Prefix, { value: "prefix-" })),
  );
});

test("invalid query encoding and cyclic or non-finite JSON fail lazily before spawning", async () => {
  const cyclic: Record<string, Schema.Json> = {};
  cyclic.self = cyclic;
  const requests: ReadonlyArray<Api.Request> = [
    { endpoint: "endpoint", method: "GET", query: { q: "\ud800" } },
    { endpoint: "endpoint", method: "GET", query: { "\ud800": "q" } },
    { endpoint: "endpoint", method: "GET", query: { n: Infinity } },
    { endpoint: "endpoint", method: "POST", body: cyclic },
    { endpoint: "endpoint", method: "POST", body: { n: NaN } },
  ];
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner();
      for (const request of requests) {
        const effect = Api.raw(request);
        expect(fake.commands).toHaveLength(0);
        expect(
          yield* effect.pipe(
            Effect.provide(layer().pipe(Layer.provide(fake.layer))),
            Effect.flip,
          ),
        ).toBeInstanceOf(GhDecodeError);
      }
      expect(fake.commands).toHaveLength(0);
    }),
  );
});

test("pages rejects writes, bodies and GraphQL before spawning", async () => {
  const requests: ReadonlyArray<Api.Request> = [
    { endpoint: "endpoint", method: "POST" },
    { endpoint: "endpoint", method: "GET", body: {} },
    { endpoint: "graphql", method: "GET" },
    { endpoint: "/graphql?query=x", method: "GET" },
  ];
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner();
      for (const request of requests) {
        // @ts-expect-error Also verify JavaScript callers cannot paginate mutations or bodies.
        const effect = Api.pages(request, Schema.Unknown);
        expect(
          yield* effect.pipe(
            Effect.provide(layer().pipe(Layer.provide(fake.layer))),
            Effect.flip,
          ),
        ).toBeInstanceOf(GhDecodeError);
      }
      expect(fake.commands).toHaveLength(0);
    }),
  );
});

test.each([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] satisfies ReadonlyArray<Api.Method>)(
  "failed %s requests are never retried",
  async (method) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fake = yield* fakeSpawner({
          stderr: textStream("HTTP 503: retry later"),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
        });
        const error = yield* Api.json(
          { endpoint: "endpoint", method, body: { value: "once" } },
          Schema.Unknown,
        ).pipe(
          Effect.provide(layer().pipe(Layer.provide(fake.layer))),
          Effect.flip,
        );
        expect(error._tag).toBe("GhCommandError");
        expect(fake.commands).toHaveLength(1);
        expect(fake.releases()).toBe(1);
      }),
    );
  },
);
