---
title: Agents
description: The effect-gh agent skill and the OpenCode plugin.
---

## Skill

[The effect-gh skill](https://github.com/timmo001/effect-gh/blob/main/skills/effect-gh/SKILL.md) guides Effect integrations towards the package and its current documentation. It follows the [Agent Skills specification](https://agentskills.io/specification).

```sh
npx skills add timmo001/effect-gh
```

Or import the complete `skills/effect-gh/` directory unchanged into your skill collection.

## OpenCode plugin

`opencode-plugin/` ships the SDK as OpenCode's `gh` Code Mode namespace, so an agent can call typed GitHub tools instead of the `gh` CLI.

## Docs for agents

These docs are served as `llms.txt`, `llms-full.txt` and a read-only MCP endpoint at `https://effect-gh.timmo.dev/mcp`. See the [overview](/#machine-readable-docs).
