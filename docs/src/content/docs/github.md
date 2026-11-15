---
title: GitHub operations
description: The typed operations for repositories, issues, pull requests, workflows, reviews and more.
---

Each operation takes an optional `repo` (or `repository`) and core execution options last. Selectors are validated before spawning and fail with `GhInvalidOptionsError`.

| Module                                         | Covers                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| `Repository`                                   | View, create, edit, fork, clone, read files and directories              |
| `Issue`, `IssueArtifact`                       | List, query, create, edit, comment, close, link branches and artifacts   |
| `PullRequest`                                  | List, query, create, edit, merge, checks, diff, checkout and status      |
| `Workflow`                                     | Runs, jobs, logs, watch, dispatch, rerun and the workflows themselves    |
| `Cache`, `Secret`, `Variable`                  | Actions caches, secrets and variables                                    |
| `Review`, `Comment`, `Discussion`              | Review threads, submitted reviews, conversation comments and discussions |
| `Attachment`                                   | Upload an image or video for use in a post                               |
| `Auth`, `Config`, `Alias`                      | Authentication, gh settings and aliases                                  |
| `Release`, `Attestation`, `Label`, `Search`    | Releases and their verification, labels and search                       |
| `Project`, `Codespace`                         | Projects and codespaces                                                  |
| `Gist`, `SshKey`, `GpgKey`, `DeployKey`, `Org` | Gists, keys and organisations                                            |
| `Extension`, `Skill`, `AgentTask`, `Cli`       | Extensions, skills, agent tasks and the gh version                       |

```ts
import { Issue, PullRequest, Repository } from "@timmo001/effect-gh";

const repository = Repository.view("owner/repo");
const issues = Issue.list({ repo: "owner/repo", state: "open", limit: 50 });
const checks = PullRequest.checks(42, {
  repository: "owner/repo",
  required: true,
});
```

Mutations never retry. See the [README](https://github.com/timmo001/effect-gh#readme) for the details of each module.

## Commands left out on purpose

These gh commands only make sense on a terminal or in a browser, so the SDK doesn't wrap them: `browse`, `completion`, `copilot`, `licenses`, `preview`, `extension browse`, the interactive `auth login`, `codespace ssh`, `code`, `jupyter` and `ports forward`. Use `Gh.interactive` to run one on the terminal.
