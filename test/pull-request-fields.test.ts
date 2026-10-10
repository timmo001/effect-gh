import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { GhDecodeError } from "../src/errors.js";
import { layer } from "../src/gh.js";
import * as PullRequest from "../src/pull-request.js";
import { fakeSpawner, textStream } from "./helpers.js";

test("get requests and decodes only the selected fields for the current branch", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner({
        stdout: textStream(
          JSON.stringify({
            number: 7,
            body: "Text",
            labels: [{ name: "bug", color: "red" }],
          }),
        ),
      });

      const result = yield* PullRequest.get({
        fields: ["number", "body", "labels"],
      }).pipe(Effect.provide(layer().pipe(Layer.provide(fake.layer))));

      expect(result).toEqual({
        number: 7,
        body: "Text",
        labels: [{ name: "bug" }],
      });
      expect(fake.commands[0]).toMatchObject({
        args: ["pr", "view", "--json=number,body,labels"],
      });
    }),
  );
});

test("get fails to decode when a selected field is missing", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner({
        stdout: textStream(JSON.stringify({ number: 7 })),
      });

      expect(
        yield* PullRequest.get({
          selector: 7,
          repository: "owner/repo",
          fields: ["number", "body"],
        }).pipe(
          Effect.provide(layer().pipe(Layer.provide(fake.layer))),
          Effect.flip,
        ),
      ).toBeInstanceOf(GhDecodeError);
      expect(fake.commands[0]).toMatchObject({
        args: [
          "pr",
          "view",
          "--repo=owner/repo",
          "--json=number,body",
          "--",
          "7",
        ],
      });
    }),
  );
});
