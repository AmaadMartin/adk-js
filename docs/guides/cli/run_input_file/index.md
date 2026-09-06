# The run input file

`adk run <agent> --replay <file>` reads a JSON file that holds the initial
session state and a list of user turns, then runs those turns against a new
session. Reach for it to replay a fixed script against an agent, in a test or in
a demo, instead of typing the turns at the interactive prompt.

## Introduction

An interactive `adk run` reads one turn at a time from the terminal. That is
fine for exploring an agent and poor for repeating a conversation, because
nothing records what you typed. The input file records it: the same state and
the same turns, in the same order, on every run.

The file has two required fields.

| Field     | Type             | Meaning                                |
| --------- | ---------------- | -------------------------------------- |
| `state`   | object           | The state the new session starts with. |
| `queries` | array of strings | The user turns, sent in order.         |

Neither field has a default. A file that omits one is rejected before the agent
runs, so a typo such as `query` for `queries` costs you an error message rather
than a run that quietly sends no turns. The CLI adds a `_time` key to `state`
holding the start time of the run.

The replayed run does not stop for input. After the last query the run ends,
whether or not the agent asked a question. If the agent was still waiting, the
CLI says so and tells you to add the answer as the next query.

## Get started

Write the file next to the agent.

```json
{
  "state": {"city": "Paris"},
  "queries": ["What is the weather?", "And tomorrow?"]
}
```

Run it.

```shell
adk run agent.ts --replay replay.json
```

Each turn is echoed as `[user]: <query>` before the agent answers, so the
transcript reads the same way an interactive session does.

## When the file is wrong

A file the CLI cannot read, or cannot validate, ends the run with exit code 1
and one message. The message names the file and every field that failed.

```
[ADK CLI] Error running agent: Invalid run input file /tmp/replay.json: queries: Invalid input: expected array, received undefined
```

Malformed JSON and a missing file are reported the same way, under
`Failed to read or parse file <path>`.

## The saved session file

`--resume <file>` reads a session saved by `--save_session` and lets you keep
talking to the agent. It is the interactive counterpart of `--replay`, and its
file is a saved session rather than the document described above.

```shell
adk run agent.ts --resume old-session.session.json
```

The CLI replays every event in the file into a new session, prints the
transcript, then hands you the prompt. It reads two fields.

| Field    | Type             | Meaning                                   |
| -------- | ---------------- | ----------------------------------------- |
| `state`  | object           | The state the session carried when saved. |
| `events` | array of objects | The transcript to replay, oldest first.   |

Both fields are optional and default to an empty object and an empty array, as
they do in adk-python's `Session` model. Every other field the file carries,
such as `id` and `appName`, is left alone. The contents of an event are not
checked, because `--save_session` writes whatever the running ADK version
produced.

A document that is not an object, or whose `state` or `events` has the wrong
type, ends the run with exit code 1 and a message naming the file and the
field.

```
[ADK CLI] Error running agent: Invalid saved session file /tmp/old.json: events: Invalid input: expected array, received string
```
