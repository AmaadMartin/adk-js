# Selecting a memory service from the CLI

`--memory_service_uri` tells the ADK CLI which memory backend to use. Reach for
it when an agent uses `LoadMemoryTool` or `PreloadMemoryTool` and its memories
must outlive the process.

## Introduction

A memory service stores finished sessions and searches them later, so a new
conversation can recall an old one. Without a flag the CLI always builds an
`InMemoryMemoryService`, which lives in the process and disappears when the
process exits. A restarted `adk web`, or a new Cloud Run revision, therefore
starts with no memories at all.

`--memory_service_uri` selects the backend the same way `--session_service_uri`
and `--artifact_service_uri` already do. The URI scheme picks the
implementation, and the rest of the URI configures it. The flag exists on
`adk web`, `adk api_server`, `adk run`, `adk deploy cloud_run`,
`adk deploy agent_engine` and `adk deploy reasoning_engine`. The two deploy
commands write the URI into the generated container's `CMD`, so the deployed
service uses the backend you chose locally.

Two schemes are supported.

| URI                            | Service                               |
| ------------------------------ | ------------------------------------- |
| `memory://`                    | `InMemoryMemoryService` — the default |
| `agentengine://<agent_engine>` | `VertexAiMemoryBankService`           |

`<agent_engine>` is either a resource id (`123`) or a fully qualified name
(`projects/my-project/locations/us-central1/reasoningEngines/123`). With the
short id, the project and location come from the `GOOGLE_CLOUD_PROJECT` and
`GOOGLE_CLOUD_LOCATION` environment variables.

Any other scheme is rejected when the command starts:

```
$ adk web --memory_service_uri=redis://cache.internal ./agents
[ADK CLI] Error starting web server: Unsupported memory service URI: redis://cache.internal
```

adk-python also maps `rag://` to a Vertex AI RAG memory service. adk-js has no
RAG memory service, so `rag://` reaches the same error.

## Get started

Serve a directory of agents on Vertex AI Agent Engine Memory Bank:

```bash
export GOOGLE_CLOUD_PROJECT=my-project
export GOOGLE_CLOUD_LOCATION=us-central1

adk web --memory_service_uri=agentengine://1234567890 ./agents
```

Deploy the same choice to Cloud Run. The URI is baked into the container
command, so the deployed service reads and writes the same Memory Bank:

```bash
adk deploy cloud_run \
  --memory_service_uri=agentengine://1234567890 \
  --session_service_uri=postgresql://user:pass@host/db \
  ./agents
```

## Resolving a URI in your own code

The CLI resolves the URI with `getMemoryServiceFromUri`, exported from
`@google/adk`. Use it when you build a `Runner` or an `AdkApiServer` yourself
and want the same URI vocabulary:

```ts
import {getMemoryServiceFromUri, InMemoryRunner} from '@google/adk';

const memoryService = getMemoryServiceFromUri(
  process.env.MEMORY_SERVICE_URI ?? 'memory://',
);
```

The function is synchronous and performs no network calls. It constructs the
service and returns it; an `agentengine://` URI creates a Vertex AI client, but
the first request happens only when the agent reads or writes a memory. An
unsupported or mal-formatted URI throws an `Error`, with any password in the
URI masked.
