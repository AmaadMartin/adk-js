# InMemoryMemoryService

`InMemoryMemoryService` stores finished conversations in the process and finds
them again by keyword. It is the memory service to reach for in prototypes and
tests, where a managed service would cost setup you do not need yet.

## Introduction

A session holds one conversation. When it ends, nothing the user said reaches
the _next_ session. A memory service closes that gap: you hand it a finished
session, and a later session searches the content by query.

`InMemoryMemoryService` is the simplest implementation of `BaseMemoryService`.
It keeps every ingested event in a `Map` and matches on **words, not meaning**.
An entry comes back only when it shares a word with the query. Store "I drive a
blue hatchback", then ask "what color is my car?", and you get nothing, because
no word overlaps. That is the service working as designed, not a defect in your
agent. When you need retrieval by meaning, use `VertexAiMemoryBankService`
instead; the interface is the same, so the swap is one constructor.

Nothing survives the process. Restart your program and the store is empty.

## Get started

This ingests one session and searches it.

```ts
import {InMemoryMemoryService, createEvent, createSession} from '@google/adk';

const memory = new InMemoryMemoryService();

await memory.addSessionToMemory(
  createSession({
    id: 'session-1',
    appName: 'myApp',
    userId: 'alice',
    events: [
      createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'I drive a blue hatchback.'}]},
      }),
    ],
  }),
);

const {memories} = await memory.searchMemory({
  appName: 'myApp',
  userId: 'alice',
  query: 'hatchback',
});

// memories[0].content.parts[0].text === 'I drive a blue hatchback.'
```

Inside an agent you do not pass the identifiers by hand. Give the `Runner` a
`memoryService`, and `Context.searchMemory(query)` scopes the search to the
running session. The `LOAD_MEMORY` and `PRELOAD_MEMORY` tools read through the
same path.

## How a search matches

The query and the event text go through one tokenizer, which takes runs of
Unicode letters, numbers and underscore, and lowercases them. So `build_id` and
`4242` are single tokens, and `Алексей` matches `Меня зовут Алексей`.

Some scripts are not space-delimited, and a token from them never lines up with
a word boundary. A query word that is not ASCII therefore also matches as a
substring of the event text, which is how `太郎` finds `私の名前は太郎です`. An
ASCII query word never matches as a substring: `thon` does not find
`I like to code in Python.`

Each event scores one point per distinct query word it matches. The service
sorts by that score, highest first, and returns **at most ten memories**. Events
with an equal score keep the order they were added in. The cap matters because
almost any two sentences share a word: without it, a one-word query returns most
of the store, and `PRELOAD_MEMORY` puts all of it in the prompt.

An event with no content parts is never stored and never returned.

## Adding one turn instead of the whole session

`addSessionToMemory` replaces everything held for that session ID. To persist
only the latest turn, call `addEventsToMemory`, which appends:

```ts
await memory.addEventsToMemory({
  appName: 'myApp',
  userId: 'alice',
  sessionId: 'session-1',
  events: [latestTurn],
});
```

Events already in the bucket under the same `id` are skipped, so re-sending a
turn is safe and the stored copy wins. Omit `sessionId` and the events land in
one shared bucket, which is enough when you do not track sessions.

`customMetadata` is part of the request for interface compatibility.
`InMemoryMemoryService` ignores it; `VertexAiMemoryBankService` reads it.

`addEventsToMemory` is optional on `BaseMemoryService`, so a caller holding the
interface should feature-detect:

```ts
if (memoryService.addEventsToMemory) {
  await memoryService.addEventsToMemory(request);
}
```

## Scoping

Memories are scoped to the `(appName, userId)` pair, and no pair can read
another's memories whatever characters the identifiers contain. A search for an
unknown pair returns an empty list rather than an error.

## Limitations

- **Ingestion is explicit.** A session reaches memory only when you call
  `addSessionToMemory` or `addEventsToMemory`.
- **Keyword matching only.** There is no ranking by relevance beyond counting
  matched words, and no stemming: `deploys` does not match `deploy`.
- **Process-local.** The store is not shared between processes and does not
  survive a restart.
