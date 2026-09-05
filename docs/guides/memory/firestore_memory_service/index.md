# FirestoreMemoryService

`FirestoreMemoryService` keeps an agent's past events in a Google Cloud
Firestore collection and searches them by keyword. Reach for it when memory
must outlive the process and the deployment already runs on Firestore.

## Introduction

The service implements `BaseMemoryService`, so the `load_memory` tool and the
memory helpers work with it unchanged. It sits between the two services that
already ship: `InMemoryMemoryService` loses everything when the process exits,
and `VertexAiMemoryBankService` needs a Vertex AI Agent Engine.

Retrieval is keyword matching, not semantic search. A write extracts the words
of each event and stores them on the document. A search extracts the words of
the query and asks Firestore for the documents that carry any one of them. So
the service finds an event that shares a word with the query, and misses one
that only shares a meaning. Memory Bank is the option when you need the second.

Every document is scoped by `appName` and `userId`, and every query filters on
both, so one user never reads another user's memories.

## Get started

The package is `@google/adk-integrations`, and it requires Node 22 or later.
The client authenticates with Application Default Credentials.

```ts
import {FirestoreMemoryService} from '@google/adk-integrations';

const memoryService = new FirestoreMemoryService();

// Write: one document per event that yields at least one keyword.
await memoryService.addSessionToMemory(session);

// Read: one query per query keyword, over {appName, userId}.
const {memories} = await memoryService.searchMemory({
  appName: 'my-app',
  userId: 'user-1',
  query: 'favourite colour',
});
```

Pass your own client when you need to name a project, a database or an
emulator, and pass `memoriesCollection` to write somewhere other than
`memories`.

```ts
import {Firestore} from '@google-cloud/firestore';
import {FirestoreMemoryService} from '@google/adk-integrations';

const memoryService = new FirestoreMemoryService({
  client: new Firestore({projectId: 'my-project'}),
  memoriesCollection: 'agent_memories',
});
```

## The stored document

One document holds one event:

| Field       | Type       | Value                                          |
| ----------- | ---------- | ---------------------------------------------- |
| `appName`   | `string`   | `session.appName`                              |
| `userId`    | `string`   | `session.userId`                               |
| `keywords`  | `string[]` | The distinct keywords of the event's text      |
| `author`    | `string`   | `event.author`                                 |
| `content`   | `object`   | The event's content, with undefined fields cut |
| `timestamp` | `number`   | `event.timestamp`, in epoch milliseconds       |

`addSessionToMemory` writes nothing for an event that has no content, no text
in its parts, or only stop words. It commits every 500 writes, the same batch
size adk-python uses, so a long session cannot build one request that Firestore
rejects for its size. A failed commit rejects, so the caller learns that the
session was not stored.

A read turns a document back into a `MemoryEntry`. A document whose `content`
is not an object is skipped with a warning, and so is a whole keyword query
that fails: one bad document or one failed query never fails the search.

## Keywords

The tokenizer is `[A-Za-z]+` over the lowercased text, and the words in
`DEFAULT_STOP_WORDS` are dropped. That list holds 133 common English words and
is exported, so you can inspect it. Pass your own `stopWords` set to replace it
outright — the default is not merged in.

```ts
import {
  DEFAULT_STOP_WORDS,
  FirestoreMemoryService,
} from '@google/adk-integrations';

const memoryService = new FirestoreMemoryService({
  stopWords: new Set([...DEFAULT_STOP_WORDS, 'agent', 'assistant']),
});
```

The tokenizer only matches ASCII letters, and this is a real limitation. Text
in Japanese, Chinese, Cyrillic or Greek yields no keyword, and neither does a
query made only of digits. Such a query returns an empty result without
touching Firestore. The rule is the same on the write side, so an event in one
of those scripts is never stored. adk-python tokenizes the same way, and
changing it here alone would make the two SDKs return different results for the
same query.

## Indexing

Each keyword runs one query that filters on `appName`, `userId` and
`keywords`. Firestore answers it from the automatic single-field indexes by
merging them, so it works with no setup. Firebase
[recommends a composite index](https://firebase.google.com/docs/firestore/query-data/index-overview)
over the three fields to avoid the cost of that merge, and it is worth adding
once the collection grows.

A search runs its keyword queries concurrently, so latency tracks the slowest
one rather than their sum. Cost tracks the number of distinct keywords in the
query.

## Differences from adk-python

The port follows
`adk-python:src/google/adk/integrations/firestore/firestore_memory_service.py`
behaviour for behaviour, with two differences worth knowing.

**Documents are not interchangeable between the two SDKs.** adk-python stores
`Event.timestamp` as epoch seconds and formats it with
`datetime.fromtimestamp(...).isoformat()`, which is local time with no zone
suffix. adk-js stores `Event.timestamp` as epoch milliseconds and formats it as
an ISO 8601 string in UTC, which is what `InMemoryMemoryService` already
returns. Point the two SDKs at separate collections.

**There is no `eventsCollection` option.** adk-python's constructor accepts
one, stores it and never reads it. Shipping a knob that does nothing is worse
than leaving it out.
