# VertexAiRagMemoryService

`VertexAiRagMemoryService` stores a finished session in a Vertex AI RAG Engine
corpus and answers a later search with a retrieval query. Reach for it when you
want semantic recall over whole conversations, and you already run a RAG corpus.

## Introduction

`InMemoryMemoryService` matches on keywords and forgets everything when the
process exits. `VertexAiMemoryBankService` stores distilled facts that Memory
Bank generates from a conversation. This service stores the conversation
itself: one RAG file per session, holding one JSON object per event. A search
runs a retrieval query over those files and returns the matching turns.

The service serves one corpus that several apps and users can share, so it
enforces a tenant boundary. Before retrieving, it lists the corpus files and
narrows the query to the files that the requesting app and user own. It then
filters every returned context by app and user again. The second filter is what
keeps the result correct when the first step cannot run, which happens when the
caller may not list the corpus, or when the corpus is too large to walk.

This is a port of adk-python's `VertexAiRagMemoryService`, so it implements
`addSessionToMemory` and `searchMemory` and nothing else.

## Get started

The service needs a project and a location. A fully qualified `ragCorpus`
supplies both, and `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` supply
them for a bare corpus id. A bare id becomes
`projects/{project}/locations/{location}/ragCorpora/{id}` on the first call.
Requests carry Application Default Credentials.

```ts
import {VertexAiRagMemoryService} from '@google/adk';

const memoryService = new VertexAiRagMemoryService({
  ragCorpus: 'projects/my-project/locations/us-central1/ragCorpora/12345',
  similarityTopK: 5,
});

await memoryService.addSessionToMemory(session);

const {memories} = await memoryService.searchMemory({
  appName: 'demo',
  userId: 'alice',
  query: 'what did we decide about the launch date',
});
```

Each entry in `memories` carries the `content` of one event, its `author`, and
its `timestamp` as an ISO-8601 string. Retrieval returns overlapping chunks of
a transcript, so chunks of one session that share a timestamp are merged and
sorted by timestamp.

Give the service to a `Runner` to let an agent search it through the
`load_memory` tool.

```ts
import {
  InMemorySessionService,
  LlmAgent,
  LOAD_MEMORY,
  Runner,
} from '@google/adk';

const runner = new Runner({
  appName: 'demo',
  agent: new LlmAgent({
    name: 'memory_agent',
    model: 'gemini-flash-latest',
    instruction: 'Answer questions about the user using memory.',
    tools: [LOAD_MEMORY],
  }),
  sessionService: new InMemorySessionService(),
  memoryService,
});
```

## What a stored session looks like

`addSessionToMemory` uploads one RAG file per session. The file holds one JSON
object per event, `{"author": ..., "timestamp": ..., "text": ...}`. An event
with no text is left out. The text parts of one event are joined with `.`, and
a newline inside a part becomes a space, so one event stays on one line.

The file is labelled `adk-memory-v1.<app>.<user>.<session>`, where each
identifier is base64url encoded. Encoding matters: a plain dotted label cannot
tell the user `alice.smith` in session `secret` apart from the user `alice` in
session `smith.secret`. Labels written before this format are still read, but
only when they split into exactly three parts.

## Configuration

| Option                    | Meaning                                                           |
| ------------------------- | ----------------------------------------------------------------- |
| `ragCorpus`               | The corpus, qualified or a bare id. Required.                     |
| `similarityTopK`          | Contexts to retrieve. Sent as `query.ragRetrievalConfig.topK`.    |
| `vectorDistanceThreshold` | Drops contexts at or above this distance. Defaults to 10.         |
| `project`, `location`     | Override the environment and the corpus name.                     |
| `ragApiClient`            | Replaces the REST client, which is how a test drives the service. |

## Failure modes

| Situation                                   | What the service does                               |
| ------------------------------------------- | --------------------------------------------------- |
| The corpus listing fails                    | Logs a warning and retrieves over the whole corpus. |
| The listing needs more than 10 pages        | Logs a warning and retrieves over the whole corpus. |
| The tenant owns no file in the corpus       | Returns no memories and skips the retrieval.        |
| A stored line is not valid JSON             | Drops that line and keeps the rest of the chunk.    |
| The project or the location is unresolvable | Throws on the first call, not at construction.      |

The two warning cases retrieve unscoped on purpose. Narrowing to a partial
listing would hide the caller's own memories, and the per-context filter still
keeps another tenant's memories out of the result.
