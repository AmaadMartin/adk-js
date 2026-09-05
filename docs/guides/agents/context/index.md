# Context service wrappers

`Context` is the object an agent callback and a tool receive. It carries the
session state and the event actions, and it wraps the services the invocation
was started with, so a callback calls `ctx.saveArtifact(...)` instead of
reaching into the invocation context and addressing the service itself.

## Introduction

An `InvocationContext` holds the artifact service, the memory service and the
session for one run. A callback could use them directly, but then every
callback has to repeat the same three things: check that the service exists,
pass the app name, the user id and the session id, and record the artifact
delta on the event. `Context` does those three things once.

`Context` is the callback and tool half of the object adk-python calls
`Context`. adk-js splits that class in two:

| Concern                                             | adk-js class  | File                                |
| --------------------------------------------------- | ------------- | ----------------------------------- |
| State, actions, artifacts, memory, auth             | `Context`     | `core/src/agents/context.ts`        |
| Node path, run id, child execution, output, routing | `NodeContext` | `core/src/workflow/node_context.ts` |

A member you expect on `Context` and do not find is likely on `NodeContext`.

Each wrapper throws when the invocation was started without the service it
needs. The message names the service, so the failure points at the runner
configuration rather than at the callback.

## Get started

```ts
import {Context} from '@google/adk';

async function afterAgent(ctx: Context) {
  // Write the finished conversation to long-term memory.
  await ctx.addSessionToMemory();
}
```

## Artifacts

`saveArtifact` returns the version it wrote and records it in
`ctx.actions.artifactDelta`, so the event that follows reports the write. The
third argument stores metadata with that version:

```ts
const version = await ctx.saveArtifact(
  'report.txt',
  {text: 'quarterly summary'},
  {source: 'summarizer'},
);
```

`getArtifactVersion` reads that metadata back. With no version argument it
returns the latest version, and it resolves `undefined` when the session holds
no such artifact:

```ts
const latest = await ctx.getArtifactVersion('report.txt');
const first = await ctx.getArtifactVersion('report.txt', 0);
```

The metadata keys an artifact service accepts are its own. `GcsArtifactService`
writes them as object metadata; `InMemoryArtifactService` stores them as given.

## Memory

`addSessionToMemory` hands the whole session to the memory service.
`searchMemory` queries it back for the same user:

```ts
await ctx.addSessionToMemory();
const found = await ctx.searchMemory('umbrella');
```

`InMemoryMemoryService` drops events with no content parts when it ingests a
session, so an event carrying only actions is not recalled.

## The invocation's scope

`ctx.isolationScope` reports the isolation scope of the invocation, or
`undefined` when it runs under none. It lives on `ReadonlyContext`, so an
instruction provider and a toolset filter read it too. It is read-only, because
the scope belongs to the invocation that every sibling context of the run
shares. The workflow half owns the writable one, on `NodeContext`.

## Differences from adk-python

`Context.addEventsToMemory` and `Context.addMemory` are not available. They
call `BaseMemoryService.add_events_to_memory` and
`BaseMemoryService.add_memory`, which adk-js's `BaseMemoryService` does not
declare.
