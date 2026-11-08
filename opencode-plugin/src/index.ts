/**
 * The effect-gh OpenCode plugin: GitHub as the `gh` Code Mode namespace, run
 * in-process through this repository's SDK. Write tools ask through the
 * `gh.write` permission, and `gh` shell commands a tool covers get a note
 * pointing at it.
 */
import { resolve } from "node:path";
import { Plugin } from "@opencode/plugin/effect";
import { Tool } from "@opencode/schema/tool";
import { Effect, Option, Schema } from "effect";
import { description, tools } from "./gh";
import { shellNudge } from "./shell-nudge";
import {
  type ClientTool,
  strictToolInput,
  ToolInput,
  type ToolAccess,
} from "./tool";

const namespace = "gh";

const decodeInput = Schema.decodeUnknownEffect(ToolInput);

const ShellInput = Schema.Struct({
  command: Schema.String,
  workdir: Schema.optionalKey(Schema.String),
  background: Schema.optionalKey(Schema.Boolean),
});

const decodeShellInput = Schema.decodeUnknownOption(ShellInput);

const toolNames: ReadonlySet<string> = new Set(tools.map((tool) => tool.name));

export default Plugin.define({
  id: "effect-gh",
  effect: (context) =>
    Effect.gen(function* () {
      if (Bun.which("gh") === null) return;

      const sessionDirectory = (sessionID: Tool.Context["sessionID"]) =>
        context.session.get({ sessionID }).pipe(
          Effect.map((session) => session.location.directory),
          Effect.mapError(
            (error) =>
              new Tool.Error({
                message: "Could not read the session's directory",
                error,
              }),
          ),
        );

      // OpenCode's prompt only shows the action for plugin permissions, so
      // the action names the tool and what it acts on; rules match it with
      // `gh.write *`.
      const assertWrite = (
        access: ToolAccess,
        call: Tool.Context,
        target: string,
        command: string,
      ) => {
        if (access !== "write") return Effect.void;

        const resource = `${namespace}_${target}`;

        return context.permission.assert({
          sessionID: call.sessionID,
          agent: call.agent,
          action: `${namespace}.write ${target}`,
          resources: [resource],
          save: [resource],
          metadata: { command },
          source: { type: "tool", messageID: call.messageID, id: call.id },
        });
      };

      const execute =
        (tool: ClientTool) => (input: ToolInput, call: Tool.Context) =>
          Effect.gen(function* () {
            const prepared = yield* tool.prepare(
              input,
              yield* sessionDirectory(call.sessionID),
            );

            const target =
              prepared.resource === undefined
                ? tool.name
                : `${tool.name} ${prepared.resource}`;

            yield* assertWrite(
              prepared.access ?? tool.access,
              call,
              target,
              prepared.summary,
            );

            return { output: yield* prepared.run };
          });

      yield* context.tool.transform((draft) => {
        draft.namespace({ name: namespace, description });

        for (const tool of tools) {
          const run = execute(tool);

          const base = {
            namespace,
            codemode: true,
            pinned: tool.pinned,
          } as const;

          draft.add({
            name: tool.name,
            description: tool.description,
            input: strictToolInput(tool.input),
            output: Schema.Unknown,
            options:
              tool.access === "write"
                ? { ...base, permission: `${namespace}.write` }
                : base,
            execute: (input, call) =>
              decodeInput(input).pipe(
                Effect.mapError(
                  (error) =>
                    new Tool.Error({
                      message: `Invalid input: ${error.message}`,
                    }),
                ),
                Effect.flatMap((decoded) => run(decoded, call)),
              ),
          });
        }
      });

      // Background shells are how long runs stay out of the foreground, so
      // they keep the shell. Tools run in the session directory, so a shell
      // with another workdir gets no note.
      yield* context.tool.hook("execute.after", (event) =>
        Effect.gen(function* () {
          if (event.tool !== "shell" && event.tool !== "bash") return;

          if (event.status !== "completed") return;

          const input = decodeShellInput(event.input);

          if (Option.isNone(input) || input.value.background === true) return;

          const { command, workdir } = input.value;

          if (workdir !== undefined && workdir !== "") {
            const directory = yield* sessionDirectory(event.sessionID).pipe(
              Effect.orElseSucceed(() => undefined),
            );

            if (
              directory === undefined ||
              resolve(directory, workdir) !== resolve(directory)
            )
              return;
          }

          const nudge = shellNudge(command, toolNames);

          if (nudge === undefined) return;

          const existing = event.result.content;

          event.result = {
            ...event.result,
            content: Array.isArray(existing)
              ? [...existing, { type: "text" as const, text: nudge }]
              : Schema.is(Schema.String)(existing)
                ? `${existing}\n\n${nudge}`
                : nudge,
          };
        }),
      );
    }),
});
