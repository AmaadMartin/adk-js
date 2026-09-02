# Conformance testing

`adk conformance` records what an agent does against a real model, then replays
those recordings offline to check that the agent still does the same thing.
Reach for it when you want a fast, deterministic regression test over agent
behaviour, and when you want the same test case to run against adk-js and
adk-python.

## Introduction

A conformance test case is a directory with a `spec.yaml` in it. The spec names
an agent, an optional initial state and the user messages to send:

```yaml
description: The agent answers a greeting
agent: my_agent
user_messages:
  - text: hello
```

Running that spec calls a model, which is slow, costs money and gives a
different answer each time. `adk conformance record` runs it once and writes
what happened next to the spec:

- `generated-recordings.yaml` — every model call and tool call, in order.
- `generated-session.yaml` — the session the run produced.

`adk conformance test` then replays the case. It runs the same agent with the
recorded responses fed back in place of the model, and compares the resulting
session events against the recorded ones. Nothing reaches the network, so the
suite is fast and its result depends only on your code.

The two commands are the same pair adk-python exposes, and the file names are
the same, so a case recorded by either SDK is replayed by the other. That is
what makes the suite a _conformance_ suite rather than a snapshot test: it
pins one behaviour that both SDKs must produce.

Use `adk integration conformance` instead when you already have recordings and
only want the adk-js runner over a single directory. It is the older, narrower
command and it is unchanged.

## Get started

Lay a case out like this, with the agent definitions in their own tree:

```
agents/
  my_agent/
    root_agent.yaml
tests/
  core/
    greeting_001/
      spec.yaml
```

Record it, then replay it:

```bash
# Calls the model named in root_agent.yaml, so credentials are needed here.
adk conformance record tests --agents_dir agents none

# Offline from here on.
adk conformance test tests --agents_dir agents
```

`record` takes the streaming mode as its last argument, so the two commands
above write and read `generated-recordings.yaml`. Passing `sse` instead writes
`generated-recordings-sse.yaml`, and `adk conformance test --streaming-mode sse`
replays that set.

With no directories given, both commands search `./tests`.

## Options

`adk conformance record [paths...] <streaming_mode>`

| Option               | Default           | What it does                     |
| -------------------- | ----------------- | -------------------------------- |
| `--agents_dir <dir>` | working directory | Where the agent definitions are. |

`adk conformance test [paths...]`

| Option                               | Default           | What it does                            |
| ------------------------------------ | ----------------- | --------------------------------------- |
| `--mode <replay\|live>`              | `replay`          | `live` is not implemented and fails.    |
| `--generate_report`                  | off               | Write a Markdown report of the results. |
| `--report_dir <dir>`                 | working directory | Where to write that report.             |
| `--streaming-mode <none\|sse\|bidi>` | unset             | Which recorded set to replay.           |
| `--agents_dir <dir>`                 | working directory | Where the agent definitions are.        |
| `--force`                            | off               | Also run the cases the runner skips.    |

`--agents_dir` and `--force` are specific to adk-js, which builds the agents in
process rather than talking to a running server.

## What you can rely on

- A case whose recordings are missing is skipped, not failed. Record it first.
- `record` deletes the generated pair before it writes, so a run that fails
  part way leaves no stale fixture behind.
- `test` writes nothing except the report.
- The command exits `0` when every case passed or was skipped, and `1` when any
  case failed or the run could not start.

## Failure modes

- `Unsupported streaming mode: bidi` — the CLI accepts `bidi`, matching
  adk-python, but no fixture names are defined for it in either SDK.
- `Function response for <name> does not match any pending function call` — a
  user message answers a long-running tool that the run never called. The
  response's id is taken from the pending call, so there has to be one.
- `Agent <name> not found in registry` — `spec.agent` names an agent that
  `--agents_dir` does not contain. During `test` this fails that one case;
  during `record` it fails the run.
