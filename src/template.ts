import { Effect } from "effect";
import { Gh, type GhOptions } from "./gh.js";

/** The available `.gitignore` templates, as gh prints them. */
export const gitignoreList = Effect.fn("Template.gitignoreList")(function* (
  options?: GhOptions,
) {
  const gh = yield* Gh;
  const output = yield* gh.execute(["repo", "gitignore", "list"], options);

  return output.stdout;
});

/** A `.gitignore` template's contents; `name` is case-sensitive, such as `Go`. */
export const gitignoreView = Effect.fn("Template.gitignoreView")(function* (
  input: { readonly name: string },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  const output = yield* gh.execute(
    ["repo", "gitignore", "view", "--", input.name],
    options,
  );

  return output.stdout;
});

/** The common licences, as gh prints them. */
export const licenseList = Effect.fn("Template.licenseList")(function* (
  options?: GhOptions,
) {
  const gh = yield* Gh;
  const output = yield* gh.execute(["repo", "license", "list"], options);

  return output.stdout;
});

/** A licence's text, by licence key or SPDX ID, such as `mit` or `AGPL-3.0`. */
export const licenseView = Effect.fn("Template.licenseView")(function* (
  input: { readonly license: string },
  options?: GhOptions,
) {
  const gh = yield* Gh;

  const output = yield* gh.execute(
    ["repo", "license", "view", "--", input.license],
    options,
  );

  return output.stdout;
});
