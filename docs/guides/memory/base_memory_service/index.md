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

They are optional because most services support neither. That creates a second
problem: `service.addMemory?.(request)` resolves with `undefined` against such a
service, so the write disappears and the caller sees success. The package
exports one dispatch helper per path to close that gap. Each helper calls the
member when the service implements it, and throws when it does not.

This mirrors `BaseMemoryService` in
[adk-python](https://github.com/google/adk-python/blob/main/src/google/adk/memory/base_memory_service.py),
where the two optional paths are concrete methods that raise
`NotImplementedError`. TypeScript cannot give an interface member a default
body, so the default moves into the helper and the error messages stay the same.

## Get started

Call the helper, not the member. Pass the service first.

```ts
import {
  VertexAiMemoryBankService,
  addEventsToMemory,
  addMemory,
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
`enable_consolidation` from it, for example. The helpers forward the request
object unchanged, so an absent field stays absent.

## What each service supports

| Service                     | `addSessionToMemory` | `addEventsToMemory` | `addMemory` |
| --------------------------- | -------------------- | ------------------- | ----------- |
| `InMemoryMemoryService`     | yes                  | no                  | no          |
| `VertexAiMemoryBankService` | yes                  | yes                 | yes         |

Against `InMemoryMemoryService` both helpers throw, because the service
implements neither optional member:

```ts
import {InMemoryMemoryService, addMemory} from '@google/adk';

await addMemory(new InMemoryMemoryService(), {
  appName: 'demo',
  userId: 'alice',
  memories: [],
});
// Error: This memory service does not support direct memory writes.
// Call addEventsToMemory(...) or addSessionToMemory(session) instead.
```

The two messages are exported as `EVENT_DELTAS_UNSUPPORTED_MESSAGE` and
`DIRECT_MEMORY_WRITES_UNSUPPORTED_MESSAGE`, so a caller can match on them
without repeating the text.

## Implementing a service

Implement `addSessionToMemory` and `searchMemory`. Add either optional member
only when the service can honour it, and omit it otherwise — an omitted member
is how a service declines the path, and the helper turns that into the error
above.

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

The helpers validate nothing. They do not reject an empty `events` array or an
empty `memories` array, and they do not wrap an error the service throws. Put
argument validation in the service, which is where adk-python puts it too.

## Limitations

- `Context` — what tools and callbacks receive — exposes `searchMemory` only, so
  an agent-side caller still passes `appName` and `userId` by hand.
- The write paths are additive. Nothing in `Runner` calls them for you.
