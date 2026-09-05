# EnvironmentToolset

`EnvironmentToolset` turns a `BaseEnvironment` into four tools an agent can
call: `Execute`, `ReadFile`, `EditFile` and `WriteFile`. Reach for it when the
agent has to work inside a directory — run a build, read a source file, apply a
small edit, create a file.

## Introduction

`BaseEnvironment` is the low-level interface. It runs a shell command, reads a
file and writes a file inside one working directory. `LocalEnvironment`
implements it with child processes on the host. Neither is a tool, so an
`LlmAgent` cannot reach either on its own.

The toolset closes that gap. It owns the environment lifecycle, builds the four
tools, and adds a system instruction naming the working directory and the rules
for choosing between the tools. Give the agent one toolset instead of four
tools, and swap in any `BaseEnvironment` subclass — a container, a remote
sandbox — without changing the agent.

Two tools do jobs that overlap, so the instruction tells the model which to
prefer. `ReadFile` returns numbered lines and a line range, which `Execute
("cat ...")` cannot. `EditFile` replaces one exact substring, where `WriteFile`
rewrites the whole file.

## Get started

```ts
import {EnvironmentToolset, LlmAgent, LocalEnvironment} from '@google/adk';

const agent = new LlmAgent({
  name: 'coder',
  model: 'gemini-2.5-flash',
  instruction: 'Write and run code in your environment.',
  tools: [new EnvironmentToolset({environment: new LocalEnvironment()})],
});
```

`LocalEnvironment` with no options creates a temporary working directory on
first use and removes it when the toolset closes. Pass `workingDir` to point it
at a directory you already have.

## The tools

| Tool        | Arguments                          | Returns                         |
| ----------- | ---------------------------------- | ------------------------------- |
| `Execute`   | `command`                          | `stdout`, `stderr`, `exit_code` |
| `ReadFile`  | `path`, `start_line`, `end_line`   | `content`, `total_lines`        |
| `EditFile`  | `path`, `old_string`, `new_string` | `message`                       |
| `WriteFile` | `path`, `content`                  | `message`                       |

Every result carries a `status` of `'ok'` or `'error'`. An error result carries
an `error` string instead of throwing, so the model can read the failure and
retry.

`EditFile` requires `old_string` to appear exactly once. It reports the match
count when the string appears more than once, and asks for more surrounding
context. Line endings do not have to agree: a search string using `\n` finds a
file using `\r\n`, and the reverse.

## Confirmation on Execute

`Execute` runs a shell command with no sandbox, so it is gated. On the first
call the tool asks the client to confirm and returns

```
{partial: 'This tool call needs external confirmation before completion.'}
```

The client approves or rejects the call, and the tool runs the command only
after an approval. A rejection returns `errorCode:
ExecuteToolErrorCode.CONFIRMATION_REJECTED`. There is no option to turn the gate
off. The three file tools are not gated, because the environment confines their
paths to its working directory.

This gate is an adk-js addition; adk-python's `ExecuteTool` has none.

## Output size

`stdout`, `stderr` and file content are capped at 30000 characters. Text over
the cap is cut and gets a notice naming the original length:

```
... (truncated, 40000 total chars)
```

Set your own cap with `maxOutputChars`:

```ts
new EnvironmentToolset({environment, maxOutputChars: 10_000});
```

The cap reaches `Execute` and `ReadFile`. The two writing tools return short
messages, so they have nothing to cap.

## Lifecycle

The toolset calls `environment.initialize()` once, on the first `getTools()` or
`processLlmRequest()`. Its `close()` closes the environment, and only when this
toolset initialized it. A second `close()` does nothing.

A command runs with a fixed 30-second timeout. A command that exceeds it is
killed, and the result carries `error: 'Command timed out after 30s.'` next to
whatever output it produced.
