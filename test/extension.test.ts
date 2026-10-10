import { expect, test } from "bun:test";
import { parseList } from "../src/extension.js";

test("parseList reads tab-separated and padded extension rows", () => {
  expect(
    parseList(
      "gh dash\tdlvhdr/gh-dash\tv4.12.0\ngh copilot  github/gh-copilot  v1.0.5\ngh local\t\t\n\n",
    ),
  ).toEqual([
    { name: "dash", repository: "dlvhdr/gh-dash", version: "v4.12.0" },
    { name: "copilot", repository: "github/gh-copilot", version: "v1.0.5" },
    { name: "local", repository: "", version: "" },
  ]);
});
