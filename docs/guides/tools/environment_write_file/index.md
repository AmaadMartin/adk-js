# WriteFileTool

Gives an agent one tool call that creates or overwrites a file inside a
`BaseEnvironment` working directory. Reach for it when the agent must author a
whole file: a new source file, a config, or a full rewrite of an existing one.

## Introduction

A `BaseEnvironment` gives an agent a working directory it can execute commands
in and read files from. `LocalEnvironment` is the built-in implementation and
runs the commands as child processes on the host.

Without a write tool an agent can only produce a file by smuggling its content
through a shell command, such as a heredoc passed to `bash`. That is brittle:
the shell rewrites quotes and backslashes, and a long file makes an unreadable
command. `WriteFileTool` declares `path` and `content` as two arguments, so the
model sends the file content as data.

The tool does no file I/O of its own. It calls `BaseEnvironment.writeFile`, so
it inherits whatever the environment enforces, and it works unchanged against
any environment implementation.

## Get started

Create an environment, initialize it, and pass it to the tool.

```ts
import {LlmAgent, LocalEnvironment, WriteFileTool} from '@google/adk';

const environment = new LocalEnvironment({workingDir: '/tmp/workspace'});
await environment.initialize();

export const rootAgent = new LlmAgent({
  name: 'file_writer',
  model: 'gemini-flash-latest',
  instruction: 'Write files with the WriteFile tool.',
  tools: [new WriteFileTool(environment)],
});
```

A runnable version is in
[`samples/tools/environment_write_file/agent.ts`](../../../../samples/tools/environment_write_file/agent.ts).

You own the environment's lifecycle. Call `initialize()` before the first tool
call and `close()` when you are done; the tool does neither.

## Arguments

The tool declares two arguments to the model, both required.

| Argument  | Type   | Meaning                                              |
| --------- | ------ | ---------------------------------------------------- |
| `path`    | string | Path to the file, relative to the working directory. |
| `content` | string | The full file content.                               |

An omitted `content` writes an empty file, matching adk-python. Parent
directories are created for you, so `docs/api/index.md` works on an empty
workspace.

## Responses

The tool never throws. It reports every outcome as a status object, so the
model reads the reason and can correct its next call.

```ts
{status: 'ok', message: 'Wrote notes.txt'}
{status: 'error', error: 'Path escapes working directory: ../notes.txt'}
```

You get `status: 'error'` when `path` is missing or empty, when `content` is
present but is not a string, and when the environment rejects the write. The
`error` field carries the environment's own message. A validation error never
reaches the environment, so no file is touched.

## Containment

`LocalEnvironment` resolves the path against its working directory and rejects
anything outside it. That check compares resolved path strings. It is a guard
against accidental traversal, not a sandbox: symlinks, hardlinks, bind mounts
and TOCTOU races all defeat it.

The tool adds no confirmation gate of its own. To ask a human before a write,
register a `SecurityPlugin` with a policy engine that returns `CONFIRM`; it
gates any tool call, so you write the policy once rather than per tool.
