import { expect, test } from "bun:test";
import { Effect } from "effect";
import * as Stack from "../src/stack.js";
import { scriptedSpawner } from "./helpers.js";

test("view decodes gh stack view --json, with optional heads, bases and pull requests", async () => {
  const gh = scriptedSpawner([
    {
      stdout: JSON.stringify({
        trunk: "main",
        currentBranch: "api",
        branches: [
          {
            name: "auth",
            head: "a1",
            base: "b1",
            isCurrent: false,
            isMerged: true,
            isQueued: false,
            needsRebase: false,
            pr: {
              number: 41,
              url: "https://github.com/o/r/pull/41",
              state: "MERGED",
            },
          },
          {
            name: "api",
            isCurrent: true,
            isMerged: false,
            isQueued: false,
            needsRebase: true,
          },
        ],
      }),
    },
  ]);

  const view = await gh.run(Stack.view());

  expect(gh.args()).toEqual([["stack", "view", "--json"]]);
  expect(view.branches.map((branch) => branch.pr?.state)).toEqual([
    "MERGED",
    undefined,
  ]);
  expect(view.branches[1]?.needsRebase).toBe(true);
});

test("commands keep values out of flag positions and only pass set options", async () => {
  const gh = scriptedSpawner([
    { stdout: "" },
    { stdout: "" },
    { stdout: "" },
    { stdout: "" },
    { stdout: "" },
    { stdout: "/work/tree\n" },
  ]);

  await gh.run(
    Effect.gen(function* () {
      yield* Stack.add({ commit: { message: "-Fix login", stage: "all" } });
      yield* Stack.submit({ open: true, atomic: false, remote: "origin" });
      yield* Stack.merge({ target: 42, method: "squash" });
      yield* Stack.link({ stack: 7, items: [48, "ui-polish"], atomic: true });
      yield* Stack.rebase({ scope: "upstack", trunk: false, branch: "-api" });

      expect(yield* Stack.navigatePath({ to: "up", count: 2 })).toBe(
        "/work/tree",
      );
    }),
  );

  expect(gh.args()).toEqual([
    ["stack", "add", "--all", "--message=-Fix login"],
    ["stack", "submit", "--auto", "--open", "--remote=origin", "--no-atomic"],
    ["stack", "merge", "--yes", "--merge-method=squash", "--", "42"],
    ["stack", "link", "--no-atomic=false", "--", "7", "48", "ui-polish"],
    ["stack", "rebase", "--upstack", "--no-trunk", "--", "-api"],
    ["stack", "up", "--print-path", "--", "2"],
  ]);
});

test("parseSync tells a linked stack, pushed branches and a divergence apart", () => {
  expect(Stack.parseSync("✓ Pushed 3 branches\n✓ Stack synced\n")).toBe(
    "stack",
  );
  expect(Stack.parseSync("✓ Branches synced\n")).toBe("branches");
  expect(
    Stack.parseSync(
      "⚠ Your local stack has diverged from the stack on GitHub\nℹ Sync aborted — no changes were made\n",
    ),
  ).toBe("diverged");
});

test("exitReason names gh-stack's exit codes and leaves generic failures undefined", () => {
  expect(Stack.exitReason({ exitCode: 3 })).toBe("conflict");
  expect(Stack.exitReason({ exitCode: 9 })).toBe("stacks-unavailable");
  expect(Stack.exitReason({ exitCode: 1 })).toBeUndefined();
});
