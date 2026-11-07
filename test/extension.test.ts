import { expect, test } from "bun:test";
import { parseList, parseUpgrades } from "../src/extension.js";

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

test("parseUpgrades reads padded names, every status and multi-line failures", () => {
  expect(
    parseUpgrades(
      [
        "[actions-lock]: already up to date",
        "[        dash]: would have upgraded from v4.26.2 to v4.27.0",
        "[         poi]: upgraded from 1a2b3c4d to 5e6f7a8b",
        "[      pinned]: pinned extensions can not be upgraded",
        "[       local]: local extensions can not be upgraded",
        "[      broken]: gh-broken unsupported for linux-arm64.",
        "",
        "To request support for linux-arm64, open an issue",
        "",
      ].join("\n"),
    ),
  ).toEqual([
    {
      name: "actions-lock",
      status: "current",
      from: "",
      to: "",
      reason: "",
    },
    {
      name: "dash",
      status: "upgraded",
      from: "v4.26.2",
      to: "v4.27.0",
      reason: "",
    },
    {
      name: "poi",
      status: "upgraded",
      from: "1a2b3c4d",
      to: "5e6f7a8b",
      reason: "",
    },
    { name: "pinned", status: "pinned", from: "", to: "", reason: "" },
    { name: "local", status: "local", from: "", to: "", reason: "" },
    {
      name: "broken",
      status: "failed",
      from: "",
      to: "",
      reason:
        "gh-broken unsupported for linux-arm64.\nTo request support for linux-arm64, open an issue",
    },
  ]);
});
