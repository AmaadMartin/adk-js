# adk run

`adk run` starts an agent from a single file. It has two modes: an interactive
REPL, and a single run that takes the message as an argument, prints the turn,
and exits with a code a script can branch on.

## Introduction

The REPL is for developing an agent by hand. You type a message, read the
answer, and answer any question the agent asks you. That is the mode you get
when you pass no query.

The single run is for everything that is not a person at a keyboard: a shell
script, a CI job, or another program. It reads one message, runs one turn, and
exits. Two things make it scriptable. `--jsonl` writes one JSON object per
event to stdout, so the caller parses events instead of scraping text. And the
exit code says what happened: `0` for a finished turn, `2` when the agent
stopped to ask a human something, `1` for a usage error, a timeout, or a failed
run.

Exit code `2` is the interesting one. An agent that waits for approval cannot
finish inside one process, so the run ends with the question recorded in its
session. You answer it by running the command again with `--session_id` and the
answer as the query: the CLI sees the pending question and sends your query back
as the answer to it, instead of starting a new turn. That is what makes a
human-in-the-loop agent usable from a script.

Sessions persist under the agent's own `.adk` folder by default, which is what
lets the second run find the first one's question. `--in_memory` turns that off,
and `--session_service_uri` points it somewhere else.

## Get started

The agent is a file that exports a root agent or a workflow.

```typescript
import {node, NodeContext, RequestInput, Workflow} from '@google/adk';

const gate = node(
  (ctx: NodeContext, request: string) => {
    const answer = ctx.resumeInputs['confirm'];
    if (answer === undefined) {
      return new RequestInput({
        interruptId: 'confirm',
        message: `Approve "${request}"?`,
      });
    }
    return `answered:${JSON.stringify(answer)}`;
  },
  {name: 'gate', rerunOnResume: true},
);

export const rootAgent = new Workflow({
  name: 'hitl_gate',
  edges: [['START', gate]],
});
```

Run it once. The workflow pauses, so the run exits `2` and tells you how to
answer.

```console
$ adk run ./agent.ts "delete everything"
--- [gate] is waiting for your input ---
Approve "delete everything"?
Type your reply at the next prompt to continue.
$ echo $?
2
```

The session id and the resume instructions are written to stderr:

```
Session ID: 54f6d288-9018-4179-beb4-f6c57cbaff7c

============================================================
[PAUSED] Workflow is waiting for human input!

To resume, run the command again with:
  --session_id 54f6d288-9018-4179-beb4-f6c57cbaff7c
And provide your input as the query.
============================================================
```

Answer it by running the command again with that session id:

```console
$ adk run ./agent.ts "yes" --session_id 54f6d288-9018-4179-beb4-f6c57cbaff7c
[gate]: answered:"yes"
$ echo $?
0
```

## Structured output

`--jsonl` replaces the transcript with one JSON object per event on stdout, and
drops the human-readable status lines. Each record leads with `author`,
`session_id`, `node_path` and `id`, and the action maps an event leaves empty
are omitted.

```console
$ adk run ./agent.ts "delete everything" --jsonl
{"author":"gate","session_id":"6c47d57e","node_path":"hitl_gate.gate","id":"ONril5D0","content":{...},"longRunningToolIds":["confirm"],...}
```

While `--jsonl` is on, stdout carries the records and nothing else. Anything
else written to stdout during the run — a log line from the copy of ADK your
agent file loaded, for instance — is moved to stderr, so a reader can parse
stdout one line at a time.

## Reading the query from stdin

An empty query argument reads the whole of stdin instead, which is how you pipe
a message in:

```console
$ echo "delete everything" | adk run ./agent.ts ""
```

## Options

| Option                                           | What it does                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `--jsonl`                                        | Write one JSON object per event to stdout.                                                              |
| `--timeout <duration>`                           | Budget for one turn, e.g. `30s` or `5m`. A turn that overruns is aborted, and the single run exits `1`. |
| `--state <json>`                                 | Seed a new session's state from a JSON object.                                                          |
| `--session_id <id>`                              | Run in this session, creating it if it does not exist.                                                  |
| `--in_memory`                                    | Persist nothing: session, artifacts and memory all stay in the process.                                 |
| `--use_local_storage` / `--no_use_local_storage` | Persist under the agent's `.adk` folder, or do not. On by default.                                      |
| `--session_service_uri <uri>`                    | `memory://`, or a database URI such as `sqlite:///path/to.db`.                                          |
| `--artifact_service_uri <uri>`                   | `memory://`, `file://<dir>` or `gs://<bucket>`.                                                         |
| `--memory_service_uri <uri>`                     | `memory://`, or `agentengine://<agent_engine_id>` for Vertex AI Memory Bank.                            |
| `--default_llm_model <model>`                    | The model for an agent that declares none, and does not inherit one from a parent.                      |
| `--replay <file>`                                | Run the queries in a json file against a new session.                                                   |

An explicit `--session_service_uri` or `--artifact_service_uri` always wins over
local storage. `--in_memory` overrides both.

## Environment

The CLI applies the nearest `.env` at or above the agent's directory before it
builds any service, so a key or a service URI the file supplies is in place when
the run needs it. A variable already exported in your shell wins over the file.
`ADK_DISABLE_LOAD_DOTENV=1` skips the file entirely.

Two variables control local storage: `ADK_DISABLE_LOCAL_STORAGE=1` forces
in-memory services, and `ADK_FORCE_LOCAL_STORAGE=1` asks for the `.adk` folder
even when the run did not. A directory the process cannot write to falls back to
in-memory services with a warning rather than failing the run.

## Failure modes

| Situation                        | What you see                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| `--state` is not a JSON object   | `Error: Invalid JSON for --state: <reason>`, exit `1`.                                            |
| A query and `--replay` together  | `Error: Cannot provide both query and --replay.`, exit `1`.                                       |
| No query and stdin is a terminal | `Error: Missing query argument or stdin input.`, exit `1`.                                        |
| The turn overruns `--timeout`    | `Error: Command timed out after <duration>`, exit `1`. The REPL reports the same and keeps going. |
| The run throws                   | `Error: <message>`, exit `1`.                                                                     |
