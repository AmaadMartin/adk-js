# BaseMemoryService

`BaseMemoryService` is the base class ADK uses to store conversation content and
search it later. It gives an agent recall that outlives a single session.

## Introduction

A session holds one conversation. When it ends, its events stay in the session
service, but nothing the user said reaches the _next_ session. The memory
service closes that gap: hand it content, and a later session can search that
content by query.

Two members are required, so every service supports them. `addSessionToMemory`
ingests a whole finished session, and `searchMemory` retrieves. The
`LOAD_MEMORY` and `PRELOAD_MEMORY` tools and the `--memory_service_uri` flag on
the CLI all sit on those two methods.

Two more write paths are optional, and the base class implements both with a
default that rejects. `addEventsToMemory` writes an incremental list of events.
`addMemory` writes `MemoryEntry` items you distilled yourself. A service that
supports neither inherits the defaults, so a caller gets an error naming the
method to call instead of losing the write in silence.

Memory is not session state. State is a dictionary you read back by key. Memory
is a corpus: you hand over content and later ask a question, and the service
decides which past content is relevant.

## Get started

This stores a finished session, then searches it from a later one. It needs no
model and no cloud project.

```ts
import {
  InMemoryMemoryService,
  InMemorySessionService,
  createEvent,
} from '@google/adk';

const sessionService = new InMemorySessionService();
const memoryService = new InMemoryMemoryService();

const session = await sessionService.createSession({
  appName: 'memoryDemo',
  userId: 'user-1',
});
await sessionService.appendEvent({
  session,
  event: createEvent({
    author: 'user',
    content: {role: 'user', parts: [{text: 'My favorite sport is badminton.'}]},
  }),
});

await memoryService.addSessionToMemory(session);

const response = await memoryService.searchMemory({
  appName: 'memoryDemo',
  userId: 'user-1',
  query: 'sport',
});
// response.memories holds one entry with the badminton content.
```

Memory is scoped by the `appName` and `userId` pair, so one user never reads
another user's memories. `searchMemory` always resolves with a
`SearchMemoryResponse` whose `memories` is an array; use
`createSearchMemoryResponse()` to build one with an empty list.

## The optional write paths

`addEventsToMemory` takes a delta. Pass only the events you want to persist,
such as the latest turn, rather than the whole session:

```ts
await memoryService.addEventsToMemory({
  appName: 'memoryDemo',
  userId: 'user-1',
  events: [latestTurnEvent],
  sessionId: session.id,
  customMetadata: {ttl: '3600s'},
});
```

`sessionId` is advisory: a service that does not partition memory that way
ignores it. `customMetadata` carries portable generation metadata, and each
service defines which keys it accepts.

`addMemory` takes explicit entries instead of events:

```ts
await memoryService.addMemory({
  appName: 'memoryDemo',
  userId: 'user-1',
  memories: [
    {content: {role: 'user', parts: [{text: 'Prefers window seats.'}]}},
  ],
});
```

Both calls above reject on `InMemoryMemoryService`, which supports neither path.
The rejection carries `EVENT_DELTAS_UNSUPPORTED_MESSAGE` or
`DIRECT_MEMORY_WRITES_UNSUPPORTED_MESSAGE`, each of which names the method to
call instead. `VertexAiMemoryBankService` overrides both, so the same calls
succeed there.

## Implementations

`InMemoryMemoryService` keeps everything in the process and is for prototyping
and tests. It matches on keywords, not meaning: an entry comes back only when it
shares a word with the query. It supports `addSessionToMemory` and
`searchMemory` only.

`VertexAiMemoryBankService` is the managed option and does semantic retrieval.
It implements all three write methods. Its `agentEngineId` option is required
and takes the bare ID, not a full resource path.

## Writing your own service

Extend `BaseMemoryService` and implement the two abstract members:

```ts
import {
  BaseMemoryService,
  SearchMemoryRequest,
  SearchMemoryResponse,
  Session,
  createSearchMemoryResponse,
} from '@google/adk';

class MyMemoryService extends BaseMemoryService {
  async addSessionToMemory(session: Session): Promise<void> {
    // Persist session.events, scoped by session.appName and session.userId.
  }

  async searchMemory(
    request: SearchMemoryRequest,
  ): Promise<SearchMemoryResponse> {
    return createSearchMemoryResponse();
  }
}
```

Use `extends`, not `implements`. `implements` does not inherit the two default
write paths, so the compiler then demands you write them yourself. Override
`addEventsToMemory` or `addMemory` only when your service really supports them;
an override fully replaces the default, and the base class does no work around
it.
