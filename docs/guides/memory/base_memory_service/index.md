# BaseMemoryService write paths

`BaseMemoryService` is the interface ADK uses to store conversation history and
search it later. Two of its four write paths are optional. Reach for them when
you want to persist one turn, or one distilled fact, instead of a whole session.

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

They are optional because most services support neither, and the absent member
is how a service declines the path. TypeScript reports a call on an optional
member as possibly undefined, so the compiler makes you check for support before
you write.

This mirrors `BaseMemoryService` in
[adk-python](https://github.com/google/adk-python/blob/main/src/google/adk/memory/base_memory_service.py),
where the same two paths are concrete methods that raise `NotImplementedError`.
Python needs that body because the method always exists on the instance, so
support is otherwise undetectable. Here the missing member carries the same
information at compile time.

## Get started

```ts
import {VertexAiMemoryBankService} from '@google/adk';

const memoryService = new VertexAiMemoryBankService({agentEngineId: '456'});

// Persist the latest turn instead of re-ingesting the whole session.
await memoryService.addEventsToMemory({
  appName: session.appName,
  userId: session.userId,
  sessionId: session.id,
  events: latestTurnEvents,
});

// Write a fact you distilled yourself.
await memoryService.addMemory({
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

Behind a `BaseMemoryService`, narrow the member before calling it:

```ts
import type {BaseMemoryService, Event} from '@google/adk';

async function persistTurn(
  service: BaseMemoryService,
  appName: string,
  userId: string,
  events: Event[],
): Promise<boolean> {
  if (!service.addEventsToMemory) {
    return false;
  }
  await service.addEventsToMemory({appName, userId, events});
  return true;
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

The interface itself validates nothing, so an empty `events` array and an empty
`memories` array both reach the service. Put argument validation in the service,
which is where adk-python puts it too.

## Limitations

- `Context` — what tools and callbacks receive — exposes `searchMemory` only, so
  an agent-side caller still passes `appName` and `userId` by hand.
- The write paths are additive. Nothing in `Runner` calls them for you.
