import { expect, test } from "bun:test";
import { Effect, Layer, Option } from "effect";
import { ChildProcessSpawner } from "effect/process";
import * as Auth from "../src/auth.js";
import { layer } from "../src/gh.js";
import { fakeSpawner, scriptedSpawner, textStream } from "./helpers.js";

test("hasToken drains the token without returning it", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner({
        stdout: textStream("gho_secret-token\n"),
      });

      const result = yield* Auth.hasToken().pipe(
        Effect.provide(layer().pipe(Layer.provide(fake.layer))),
      );

      expect(result).toBe(true);
      expect(JSON.stringify(result)).not.toContain("gho_");
      expect(fake.commands[0]).toMatchObject({ args: ["auth", "token"] });
    }),
  );
});

test("login sends the token on stdin, never as an argument", async () => {
  const gh = scriptedSpawner([{ stdout: "" }]);

  await gh.run(
    Auth.login({
      token: "ghp_secret",
      hostname: "github.example",
      gitProtocol: "https",
      skipSshKey: true,
    }),
  );
  expect(gh.args()).toEqual([
    [
      "auth",
      "login",
      "--with-token",
      "--hostname",
      "github.example",
      "--git-protocol",
      "https",
      "--skip-ssh-key",
    ],
  ]);
  expect(gh.stdins).toEqual(["ghp_secret"]);
});

test("logout, setupGit and switchAccount pass host and user as flags", async () => {
  const gh = scriptedSpawner([]);

  await gh.run(Auth.logout({ hostname: "github.com", user: "octocat" }));
  await gh.run(Auth.setupGit({ hostname: "github.example", force: true }));
  await gh.run(Auth.switchAccount({ user: "octocat" }));
  expect(gh.args()).toEqual([
    ["auth", "logout", "--hostname", "github.com", "--user", "octocat"],
    ["auth", "setup-git", "--hostname", "github.example", "--force"],
    ["auth", "switch", "--user", "octocat"],
  ]);
});

test("status and hasToken report a logged-out gh as false", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fake = yield* fakeSpawner({
        stderr: textStream("You are not logged into any GitHub hosts"),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
      });

      const provide = Effect.provide(layer().pipe(Layer.provide(fake.layer)));

      expect(yield* Auth.status("github.com").pipe(provide)).toBe(false);
      expect(yield* Auth.hasToken().pipe(provide)).toBe(false);
      expect(fake.commands[0]).toMatchObject({
        args: ["auth", "status", "--hostname", "github.com"],
      });
    }),
  );
});

test.each([
  ["HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n", Option.none()],
  [
    "HTTP/2.0 200 OK\r\nX-Oauth-Scopes: repo, read:org\r\n\r\n",
    Option.some(["repo", "read:org"]),
  ],
  [
    "HTTP/2.0 200 OK\r\nX-Oauth-Scopes: repo, workflow\r\n\r\n",
    Option.some(["repo", "workflow"]),
  ],
])(
  "scopes separates fine-grained tokens from classic scopes: %#",
  async (stdout, expected) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fake = yield* fakeSpawner({ stdout: textStream(stdout) });

        expect(
          yield* Auth.scopes().pipe(
            Effect.provide(layer().pipe(Layer.provide(fake.layer))),
          ),
        ).toEqual(expected);
        expect(fake.commands[0]).toMatchObject({
          args: [
            "api",
            "--method",
            "HEAD",
            "--hostname=github.com",
            "--include",
            "--",
            "user",
          ],
        });
      }),
    );
  },
);
