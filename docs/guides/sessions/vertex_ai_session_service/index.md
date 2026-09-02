# VertexAiSessionService

`VertexAiSessionService` stores sessions in Vertex AI Agent Engine Sessions.
Reach for it when a deployed Agent Engine owns the conversation record, so the
sessions your agent writes are the sessions the platform serves.

## Introduction

Every session service implements the same `BaseSessionService` contract, so an
agent does not change when you swap one for another. What changes is where the
record lives and what the backend guarantees. `InMemorySessionService` keeps
sessions in the process and loses them on restart. `DatabaseSessionService`
writes to a database you run. `VertexAiSessionService` calls the Agent Engine
Sessions REST API, so the sessions belong to a reasoning engine rather than to
your process.

Two consequences follow from the record living on a remote service. First, the
service addresses a session by resource name, and the id you pass becomes part
of a URL, so an id is validated before any call goes out. Second, an event has
to survive a round trip through a schema that does not model every ADK field;
the service stores the full event under `rawEvent` and rebuilds from it on
read, falling back to the API's own fields when that payload is missing or
unusable.

The service is experimental. Its shape follows adk-python's
`VertexAiSessionService`, and the differences are called out below.

## Get started

The service authenticates with Application Default Credentials. `appName` is
the reasoning engine id, or its full resource name; pass `agentEngineId` to fix
it once instead.

```ts
import {VertexAiSessionService} from '@google/adk';

const sessionService = new VertexAiSessionService({
  projectId: 'my-project',
  location: 'us-central1',
  agentEngineId: '1234567890',
});

const session = await sessionService.createSession({
  appName: '1234567890',
  userId: 'user-1',
  state: {locale: 'en-US'},
});

const reloaded = await sessionService.getSession({
  appName: '1234567890',
  userId: 'user-1',
  sessionId: session.id,
});
```

## Session ids

A session id must match `^[A-Za-z0-9_-]+$`. Anything else throws before the
call is made, because the id is interpolated into the request path.

`createSession` returns the short id, but the API also reports the full
resource name. `getSession`, `deleteSession` and `createSession` accept either:
a name ending in `sessions/<id>` is reduced to `<id>` first.

```ts
// Both of these read the same session.
await sessionService.getSession({
  appName: '1234567890',
  userId: 'user-1',
  sessionId: 'session-123',
});
await sessionService.getSession({
  appName: '1234567890',
  userId: 'user-1',
  sessionId:
    'projects/my-project/locations/us-central1/reasoningEngines/1234567890' +
    '/sessions/session-123',
});
```

A resource name naming a different reasoning engine throws rather than reading
another engine's session.

## Session expiration and extra configuration

`createSession` takes `ttl` or `expireTime`, and rejects both together. It also
takes the `displayName` and `labels` the Agent Engine session resource carries.

```ts
await sessionService.createSession({
  appName: '1234567890',
  userId: 'user-1',
  ttl: '7200s',
  displayName: 'Support chat',
  labels: {team: 'search'},
});
```

## Listing order

`listSessions` sorts by last update time, then user id, then session id. The
API returns no guaranteed order, and a paged list has no order across its
pages, so the sort is applied to the aggregated result before `limit`, `offset`
and `page` slice it. Pass `order: 'desc'` to reverse the time comparison; the
tie-break stays ascending.

## Express Mode

An API key authenticates without Application Default Credentials. Set
`GOOGLE_GENAI_USE_ENTERPRISE=true` (or the deprecated
`GOOGLE_GENAI_USE_VERTEXAI`), then pass the key or put it in `GOOGLE_API_KEY`.

```ts
const expressService = new VertexAiSessionService({
  expressModeApiKey: process.env.MY_AGENT_ENGINE_API_KEY,
  agentEngineId: '1234567890',
});
```

A project and location together take priority: a service configured with both
keeps using Application Default Credentials even when `GOOGLE_API_KEY` is set
in the environment. adk-python prefers the key there.

## What the service does not support

`getUserState` always rejects. The Agent Engine API does not expose user state
independently of a session, so read it by enumerating sessions with
`listSessions` and calling `getSession` on each result.
