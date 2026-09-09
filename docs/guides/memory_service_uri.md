# Memory service URIs

`getMemoryServiceFromUri` turns a URI string into a `BaseMemoryService`. The
`adk` CLI uses it to build the memory service for `--memory_service_uri`, so an
operator can pick a memory backend without writing any code.

## Introduction

A `Runner` accepts a `memoryService`, and adk-js ships two implementations of
it: `InMemoryMemoryService` and `VertexAiMemoryBankService`. Selecting one used
to require your own entry point, because the CLI always built the in-memory
service. Every `adk web`, `adk api_server` and `adk run` process therefore
forgot everything when it exited.

This resolver closes that gap. It is the memory counterpart of
`getSessionServiceFromUri` and `getArtifactServiceFromUri`, and it behaves the
same way: a known scheme returns a service, and an unknown scheme throws with
the URI password redacted. Reach for it when you want a durable memory backend
during development, or when you deploy an agent and want its memories to
outlive the container.

`adk --help` lists the accepted schemes. This guide covers the parts the flag
text has no room for: where the project and the location come from, and what
happens when a URI is wrong.

## Get started

Point the dev server at a Vertex AI Agent Engine Memory Bank:

```bash
export GOOGLE_CLOUD_PROJECT=my-project
export GOOGLE_CLOUD_LOCATION=us-central1

adk web ./agents --memory_service_uri agentengine://1234567890
```

Agents that carry `LOAD_MEMORY` or `PRELOAD_MEMORY` now read from the Memory
Bank instead of the process-local store.

The same resolver is available to your own code:

```ts
import {
  getMemoryServiceFromUri,
  InMemorySessionService,
  LlmAgent,
  Runner,
} from '@google/adk';

const rootAgent = new LlmAgent({name: 'root', model: 'gemini-2.0-flash'});
const sessionService = new InMemorySessionService();
const memoryService = getMemoryServiceFromUri('agentengine://1234567890');

const runner = new Runner({
  appName: 'my-app',
  agent: rootAgent,
  sessionService,
  memoryService,
});
```

## Where the project and the location come from

A bare agent engine id reads `GOOGLE_CLOUD_PROJECT` and
`GOOGLE_CLOUD_LOCATION`, and fails when either is unset. The CLI loads a `.env`
file at startup, so both can live there instead of the shell.

Pass the full resource name when you cannot rely on the environment, for
example in a deployed container that sets neither variable. It carries the
project, the location and the id, so nothing is read from the environment:

```
agentengine://projects/my-project/locations/us-central1/reasoningEngines/1234567890
```

## When a URI is wrong

Every failure is a thrown `Error`. The CLI catches it, prints the message and
exits with status 1. An unknown scheme is an error rather than a silent fall
back to `InMemoryMemoryService`, so a typo stops the server instead of quietly
giving you a memory service that loses everything on exit.

The message redacts any password the URI carries, so `memorydb://user:pw@host/db`
is reported as `memorydb://user:***@host/db`.

## Deployment

`adk deploy cloud_run`, `adk deploy agent_engine` and
`adk deploy reasoning_engine` accept the same flag. They write it onto the
generated Dockerfile's `CMD` line, so the deployed `adk api_server` resolves the
same URI. The value is shell-quoted, and a value containing a newline is
rejected rather than written, because a newline would end the `CMD` instruction.
