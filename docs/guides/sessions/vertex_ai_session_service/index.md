# VertexAiSessionService

`VertexAiSessionService` stores sessions and events in Vertex AI Agent Engine
instead of in your own process or database. Reach for it when the agent runs on
Agent Engine, or when several services must read the same conversation.

## Introduction

Every session service implements the same `BaseSessionService` interface, so the
agent code does not change when you swap one for another. What changes is where
the data lives and which guarantees you get. `InMemorySessionService` loses
everything when the process exits. `DatabaseSessionService` needs a database you
run. `VertexAiSessionService` delegates to the Agent Engine Sessions API, so
Google stores the sessions and any client with the right credentials can read
them.

That remote backend also decides the identifiers. A session lives at
`projects/P/locations/L/reasoningEngines/E/sessions/S`, and the REST API returns
that full resource name. The service accepts either form: pass the full name or
the short id `S`. It reduces the name to `S` before it builds a request, and it
rejects a name whose reasoning engine differs from the one the service is
configured for, so a copied name cannot silently address another engine's
session.

## Get started

The service needs a project, a location and Application Default Credentials.
`appName` is either the reasoning engine id or its full resource name.

```ts
import {VertexAiSessionService} from '@google/adk';

const sessionService = new VertexAiSessionService({
  projectId: 'my-project',
  location: 'us-central1',
});

const session = await sessionService.createSession({
  appName: '1234567890',
  userId: 'user-1',
  state: {locale: 'en-US'},
});

// The full resource name the REST API returns also works here.
const reloaded = await sessionService.getSession({
  appName: '1234567890',
  userId: 'user-1',
  sessionId: session.id,
});
```

Set `agentEngineId` in the options if you prefer to keep the engine out of every
`appName`.

## Session ids

A session id must match `^[A-Za-z0-9_-]+$`. `createSession`, `getSession`,
`deleteSession` and `appendEvent` reject anything else before they issue a
request, because the id is interpolated into a resource path:

```ts
await sessionService.getSession({
  appName: '1234567890',
  userId: 'user-1',
  sessionId: '../other-session',
});
// Error: Invalid sessionId '../other-session': must match ^[A-Za-z0-9_-]+$.
```

A full resource name is reduced to its short id first, so it passes the check.
An id from a different reasoning engine does not:

```ts
const service = new VertexAiSessionService({
  projectId: 'my-project',
  location: 'us-central1',
  agentEngineId: '1234567890',
});

await service.getSession({
  appName: '1234567890',
  userId: 'user-1',
  sessionId: 'projects/p/locations/l/reasoningEngines/999/sessions/abc',
});
// Error: Session resource name mismatch: session belongs to reasoningEngine
// '999', but service is configured for '1234567890'.
```

The `Session` you get back always carries the short id, whichever form you
passed in.

## Express Mode

Vertex AI Express Mode authenticates with an API key instead of Application
Default Credentials. Enable enterprise mode and supply the key, and the service
builds an API-key client:

```ts
process.env.GOOGLE_GENAI_USE_ENTERPRISE = 'true';

const sessionService = new VertexAiSessionService({
  expressModeApiKey: 'my-api-key',
});
```

The key also resolves from `GOOGLE_API_KEY`. `projectId` and `location` win when
you give both: the service only falls back to the key when it cannot build a
project client. Passing `expressModeApiKey` together with `projectId` or
`location` throws, because the two auth mechanisms are exclusive.

## Listing sessions

`listSessions` reads every page from the backend, then orders the result by
`(lastUpdateTime, userId, id)` ascending. The ordering is unconditional, so two
identical calls return the same sequence whatever order the backend paginated
in.

```ts
const {sessions, totalItems} = await sessionService.listSessions({
  appName: '1234567890',
  userId: 'user-1',
});
```

`order: 'desc'` reverses the update-time comparison only. The `userId` and `id`
tie-breaks stay ascending, so sessions sharing a timestamp still come back in a
stable order. `limit`, `offset` and `page` slice the ordered list.

## What the backend cannot do

`getUserState` always rejects. The Agent Engine API has no way to read user
state without a session, so there is nothing to call. To read user state,
enumerate sessions with `listSessions` and call `getSession` on each result.
