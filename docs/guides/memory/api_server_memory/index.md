# Adding a session to memory over HTTP

`PATCH /apps/{app}/users/{user}/memory` hands a finished session to the API
server's memory service. Reach for it when something outside the agent decides
a conversation is worth remembering.

## Introduction

A memory service stores finished conversations so a later session can search
them. The API server that `adk web` and `adk api_server` start already holds
one, and gives it to every `Runner` it builds. Until this route existed, only
code running inside an agent could write to it: a callback or a tool called
`addSessionToMemory`, and an operator with a session id had no way in.

That is the wrong place for the decision in two common setups. A support tool
promotes a conversation to memory after a human marks it resolved. A batch job
walks yesterday's sessions and ingests the ones that reached an answer. Both
know the session id and neither wants to run a model turn to trigger ingestion.

The route takes the session id in the body and the scope from the path. The
server loads the session through its own session service, so a caller cannot
promote a session belonging to another user or another app. It writes nothing
else: the session is not modified and no agent runs.

This matches `adk-python`'s `patch_memory`
(`src/google/adk/cli/api_server.py`), so a tool written against the Python
server works against the TypeScript one.

## Get started

Start a server, then promote a session:

```bash
curl -i -X PATCH http://localhost:8000/apps/demo/users/u1/memory \
  -H 'Content-Type: application/json' \
  -d '{"sessionId": "s1"}'
# HTTP/1.1 204 No Content
```

`AdkApiClient` wraps the same route:

```ts
import {AdkApiClient} from '@google/adk-devtools';

const client = new AdkApiClient({backendUrl: 'http://localhost:8000'});

await client.addSessionToMemory({
  appName: 'demo',
  userId: 'u1',
  sessionId: 's1',
});
```

The method resolves to `undefined` on success. It throws an `Error` carrying the
server's message on any other status.

## Request and responses

The body has one required field:

```json
{"sessionId": "s1"}
```

| Status | Body                                                                   | When                                                  |
| ------ | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| `204`  | empty                                                                  | The session's events reached the memory service.      |
| `400`  | `{"error": "Update memory request is invalid: sessionId is required"}` | `sessionId` is absent, empty, or not a string.        |
| `404`  | `{"error": "Session not found: s1"}`                                   | No session with that id exists for this app and user. |
| `500`  | `{"error": "Failed to update memory: <error>"}`                        | The memory service or the session service failed.     |

On a `400` or a `404` the memory service is never called.

## What gets stored

The route calls `addSessionToMemory` on whichever service the server was built
with. What that means depends on the service, and the default is
`InMemoryMemoryService`:

```ts
import {AdkApiServer} from '@google/adk-devtools';
import {InMemoryMemoryService} from '@google/adk';

const server = new AdkApiServer({
  agentsDir: './agents',
  memoryService: new InMemoryMemoryService(),
});
await server.start();
```

`InMemoryMemoryService` stores the events that carry content, keyed by session
id, and it matches on keywords rather than meaning: a query finds an entry only
when the two share a word. It also loses everything when the process exits.
Pass `VertexAiMemoryBankService` for anything beyond a prototype.

Because `InMemoryMemoryService` keys by session id, patching the same session
again replaces the stored events with the session's current ones. Patch after
the conversation ends, so the stored copy is complete.
