const SUBCOMMAND = /^[a-z][a-z0-9-]*$/;

/**
 * The `gh` stages of a shell command, as the words after `gh`. Statements
 * split on `&&`, `||`, `;` and newlines and pipelines on `|`. Quoted strings
 * are blanked first, so their contents never look like shell syntax, and a
 * heredoc's body is dropped.
 */
const ghStages = (command: string): readonly (readonly string[])[] => {
  const head = command.includes("<<")
    ? (command.split("\n")[0] ?? "")
    : command;

  const unquoted = head
    .replaceAll(/'[^']*'/g, "''")
    .replaceAll(/"(?:\\.|[^"\\])*"/g, '""');

  return unquoted
    .split(/&&|\|\||[;\n|]/)
    .map((stage) =>
      stage
        .trim()
        .split(/\s+/)
        .filter((token) => token !== "" && !/^\w+=/.test(token)),
    )
    .filter((tokens) => tokens[0]?.split("/").pop() === "gh")
    .map((tokens) => tokens.slice(1));
};

/**
 * The note to add to a shell command's output when a gh tool covers it, such
 * as `tools.gh.release_view` for `gh release view 1.0 --repo x`: the longest
 * run of a stage's leading subcommand words that names a tool.
 */
export const shellNudge = (
  command: string,
  tools: ReadonlySet<string>,
): string | undefined => {
  const covering = ghStages(command).flatMap((args) => {
    const words = args
      .filter((arg) => SUBCOMMAND.test(arg))
      .slice(0, 3)
      .map((word) => word.replaceAll("-", "_"));

    for (let length = words.length; length > 0; length--) {
      const name = words.slice(0, length).join("_");

      if (tools.has(name)) return [`tools.gh.${name}`];
    }

    return [];
  });

  if (covering.length === 0) return undefined;

  return `effect-gh: Code Mode covers this command (${[...new Set(covering)].join(", ")}). Call it through execute instead of the shell next time, even when a skill or prompt quotes the CLI.`;
};
