# ADK CLI options

The `adk` command runs, serves and deploys an agent. This guide covers the
options that decide where a run stores its data, how it reports events, and
whether it opens a prompt or answers one question and exits.

## Introduction

`adk run` used to do one thing: open an interactive prompt and keep it open. A
script cannot use that. It also kept every session in memory, so restarting the
command lost the conversation.

Four groups of options change that, and they match the flags of the same names
in adk-python:

- A **query operand** turns `adk run` into a single-shot command with a process
  exit code, and `--jsonl` makes its output machine readable.
- **Local storage** persists sessions and artifacts under `<agents_dir>/.adk`.
  It is the default, and `--no_use_local_storage` restores the in-memory
  behaviour.
- **Service URIs** point a run at a session, artifact or memory backend.
- **Feature flags** turn an experimental feature on for one command.

`adk telemetry` sits beside them. It records whether you allow Google to collect
usage data. adk-js has no collector yet, so the preference is stored and nothing
reads it.

## Get started

Send one message and read the answer:

```bash
adk run ./agent.ts "what is the weather in Boston?"
```

The agent's reply goes to stdout. The session id goes to stderr, so a pipeline
can keep the two apart:

```bash
adk run ./agent.ts "hello" --jsonl > events.jsonl
```

Each line of `events.jsonl` is one event, with `author`, `session_id`,
`node_path` and `id` first:

```json
{
  "author": "echo_agent",
  "session_id": "6eace836-...",
  "id": "h6BNXEA5",
  "content": {"role": "model", "parts": [{"text": "echo: hello"}]}
}
```

Without a query, `adk run` opens the interactive prompt as before.

## Storage

`adk run`, `adk web` and `adk api_server` store sessions in
`<agents_dir>/.adk/sessions.db` and artifacts in `<agents_dir>/.adk/artifacts`.
A second run with `--session_id` continues the first:

```bash
SESSION=$(adk run ./agent.ts "my name is Ada" 2>&1 >/dev/null | sed -n 's/^Session ID: //p')
adk run ./agent.ts "what is my name?" --session_id "$SESSION"
```

Three ways to opt out:

| Option                                             | Effect                                                       |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `--no_use_local_storage`                           | Keeps sessions and artifacts in memory.                      |
| `--in_memory`                                      | Same, and it also overrides any service URI. `adk run` only. |
| `--session_service_uri` / `--artifact_service_uri` | Points at a named backend.                                   |

A service URI and a storage flag cannot be combined, because they answer the
same question. Using both is a usage error and exits with code 2:

```
error: --use_local_storage/--no_use_local_storage cannot be used with --session_service_uri or --artifact_service_uri.
```

Local storage steps aside on its own when it cannot work: when
`ADK_DISABLE_LOCAL_STORAGE` is set, when the agents directory is not writable,
and on Cloud Run or Kubernetes. Each of those logs a warning and falls back to
in-memory. `ADK_FORCE_LOCAL_STORAGE=1` overrides the last two.

## Service URIs

`--memory_service_uri` selects the memory service, alongside the existing
`--session_service_uri` and `--artifact_service_uri`:

| URI                                                              | Service                                                                                                                 |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `memory://`                                                      | `InMemoryMemoryService`                                                                                                 |
| `agentengine://<id>`                                             | `VertexAiMemoryBankService`, with the project and location read from `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` |
| `agentengine://projects/<p>/locations/<l>/reasoningEngines/<id>` | `VertexAiMemoryBankService` for that engine                                                                             |

Any other URI is rejected. That includes `rag://`, which adk-python maps to its
Vertex AI RAG memory service; adk-js has no equivalent.

The same resolver is available to code:

```ts
import {getMemoryServiceFromUri} from '@google/adk';

const memoryService = getMemoryServiceFromUri('agentengine://123');
```

## Feature flags

`--enable_features` and `--disable_features` override the feature registry for
one command. Both are repeatable and both accept a comma-separated list:

```bash
adk run ./agent.ts "hello" --enable_features=PROGRESSIVE_SSE_STREAMING
```

A name in both lists ends up disabled. An unknown name prints a warning on
stderr and the command still runs:

```
WARNING: Unknown feature name 'NOT_A_FEATURE'. Valid names are: PROGRESSIVE_SSE_STREAMING
```

## Exit codes

| Code | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| 0    | The run finished.                                                    |
| 1    | A usage error inside `run`, or the run failed.                       |
| 2    | A commander usage error, or the run finished waiting on human input. |

Code 2 is overloaded in adk-python too, and adk-js matches it. When a run pauses
for human input, it prints the `--session_id` to resume with, and the next
invocation answers the pending request instead of starting a new turn.

## Telemetry

```bash
adk telemetry status    # Telemetry collection is not configured (defaults to OFF).
adk telemetry enable
adk telemetry disable
```

The preference is stored in `~/.adk/config.json` under the `telemetry` key, the
same file adk-python uses. The first time you run any other subcommand on a
terminal, the CLI asks once and records the answer. It never asks when stdin is
not a terminal, so a CI run cannot block on it.
