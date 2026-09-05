# BaseMemoryService write paths

`BaseMemoryService` is the interface ADK uses to store conversation history and
search it later. Two of its write paths are optional. Reach for them when you
want to persist one turn, or one distilled fact, instead of a whole session.

## Introduction

`addSessionToMemory(session)` is the required entry point, and it takes a whole
`Session`. That is the right unit when a conversation ends, and the wrong unit
in two common cases. A long-running agent that ingests after every turn re-sends
the entire transcript each time. An agent that has already distilled a fact
("the user prefers metric units") has no session to hand over at all.

The interface therefore carries two optional members:

- `addEventsToMemory` writes an explicit list of events. A service treats the
  list as an incremental delta and must not assume it is the full session.
- `addMemory` writes `MemoryEntry` items directly.

They are optional because most services support neither. The package also
exports two functions of the same names that take the service as their first
argument. Call one of those and the write always has an outcome: it reaches the
service, or it rejects with `NotImplementedError` naming the path to use
instead. It never resolves without storing anything.

This mirrors `BaseMemoryService` in
[adk-python](https://github.com/google/adk-python/blob/main/src/google/adk/memory/base_memory_service.py),
where the two paths are concrete methods that raise `NotImplementedError`. A
Python subclass inherits that default for free. A TypeScript interface cannot
carry a method body, and adding required members to a published interface
breaks every external implementer, so the default lives in the exported
functions instead.

## Get started

```ts
import {
  addEventsToMemory,
  addMemory,
  VertexAiMemoryBankService,
} from '@google/adk';

const memoryService = new VertexAiMemoryBankService({agentEngineId: '456'});

// Persist the latest turn instead of re-ingesting the whole session.
await addEventsToMemory(memoryService, {
  appName: session.appName,
  userId: session.userId,
  sessionId: session.id,
  events: latestTurnEvents,
});

// Write a fact you distilled yourself.
await addMemory(memoryService, {
  appName: session.appName,
  userId: session.userId,
  memories: [
    {content: {role: 'user', parts: [{text: 'prefers metric units'}]}},
  ],
});
```

`sessionId` is optional, and a service that does not partition memory that way
ignores it. Both requests also accept `customMetadata`, a portable record whose
supported keys each service defines. `VertexAiMemoryBankService` reads
`enable_consolidation` from it, for example.

## Handling an unsupported path

`InMemoryMemoryService` generates memory from whole sessions only, so a direct
write reports itself:

```ts
import {
  addMemory,
  InMemoryMemoryService,
  NotImplementedError,
} from '@google/adk';

try {
  await addMemory(new InMemoryMemoryService(), {
    appName: 'myApp',
    userId: 'alice',
    memories: [
      {content: {role: 'user', parts: [{text: 'prefers metric units'}]}},
    ],
  });
} catch (error: unknown) {
  if (!(error instanceof NotImplementedError)) {
    throw error;
  }
  // "This memory service does not support direct memory writes. Call
  //  addEventsToMemory(...) or addSessionToMemory(session) instead."
}
```

The functions add nothing else. They validate no argument, and an error the
service itself throws reaches you unchanged.

To branch on support instead of catching, read the member:

```ts
if (service.addEventsToMemory) {
  await service.addEventsToMemory(request);
}
```

## What each service supports

| Service                     | `addSessionToMemory` | `addEventsToMemory` | `addMemory` |
| --------------------------- | -------------------- | ------------------- | ----------- |
| `InMemoryMemoryService`     | yes                  | no                  | no          |
| `VertexAiMemoryBankService` | yes                  | yes                 | yes         |

## Implementing a service

Implement `addSessionToMemory` and `searchMemory`. Add either optional member
only when the service can honour it, and omit it otherwise.

```ts
import type {AddEventsToMemoryRequest, BaseMemoryService} from '@google/adk';

const service: BaseMemoryService = {
  async addSessionToMemory(session) {
    await ingest(session.appName, session.userId, session.events);
  },
  async addEventsToMemory(request: AddEventsToMemoryRequest) {
    // The events are a delta. Append them; do not replace what is stored.
    await ingest(request.appName, request.userId, request.events);
  },
  async searchMemory(request) {
    return {
      memories: await lookup(request.appName, request.userId, request.query),
    };
  },
};
```

An empty `events` array and an empty `memories` array both reach the service,
so put argument validation in the service. That is where adk-python puts it too.

## Limitations

- `Context` — what tools and callbacks receive — exposes `searchMemory` only, so
  an agent-side caller still passes `appName` and `userId` by hand.
- The write paths are additive. Nothing in `Runner` calls them for you.
