import { docsConfig } from "@timmo001/docs-kit/blume";
import { defineConfig } from "blume";

export default defineConfig(
  docsConfig({
    title: "effect-gh",
    description: "An Effect v4 SDK for the GitHub CLI.",
    site: "effect-gh.timmo.dev",
    github: { owner: "timmo001", repo: "effect-gh" },
    navigation: {
      sidebar: [
        "/",
        "/install",
        "/core",
        "/api",
        "/github",
        "/agents",
        "/development",
      ],
    },
  }),
);
