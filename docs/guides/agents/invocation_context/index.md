# Invocation-scoped state on `InvocationContext`

`InvocationContext` carries the per-run state that every agent, tool and
service of one invocation shares. This guide covers the three slots a live
(bidirectional) run and a host application use: the realtime audio caches, the
background tool-task registry, and the custom metadata record.

## Introduction

One invocation can run many agents. The runner builds a root context, and
`BaseAgent` derives a child context for each sub-agent, transfer and loop
iteration. Those children are copies, so a field only survives the whole run if
the constructor carries it over by reference. The three slots below do exactly
that: a write through any context of the invocation is visible on every other
one.

`customMetadata` is the slot a host application reaches for. Set
`RunConfig.customMetadata` on the run, and the context exposes a mutable copy
of it that tools and services can read and extend. Use it for values that
belong to the request rather than to the conversation — a tenant id, a trace
correlation id, a debug flag. Session state is the wrong place for those,
because it persists past the run.

The other two slots exist for the live path. `inputRealtimeCache` and
`outputRealtimeCache` buffer audio chunks before a flush to the session and
artifact services. `activeNonBlockingToolTasks` holds the background tool tasks
a live run started, so the flow can cancel them when the run ends.
Nothing in `adk-js` writes to these two yet; they are the storage the live flow
needs, and they match the shape `adk-python` uses.

## Get started

Pass metadata in through the run config, then read it from any context of the
run:

```ts
import {InvocationContext, PluginManager} from '@google/adk';

const context = new InvocationContext({
  invocationId: 'inv-1',
  session,
  pluginManager: new PluginManager(),
  runConfig: {customMetadata: {tenant: 'acme'}},
});

context.customMetadata['requestStart'] = Date.now();
```

A tool running under a sub-agent writes to the same record:

```ts
protected async *runAsyncImpl(
  context: InvocationContext,
): AsyncGenerator<Event, void, void> {
  context.customMetadata['stage'] = 'retrieval';
  // The parent context sees this write.
}
```

## Guarantees

`customMetadata` is always an object, so no null check is needed before a
write. The constructor seeds it with a shallow copy of
`RunConfig.customMetadata`, so a write never reaches the caller's run config:

```ts
const runConfig = {customMetadata: {tenant: 'acme'}};
const context = new InvocationContext({/* … */ runConfig});

context.customMetadata['extra'] = 1;
// runConfig.customMetadata is still {tenant: 'acme'}.
```

Seeding happens once, for a fresh invocation. A copy keeps the record it was
given rather than reseeding from a new run config:

```ts
const clone = context.clone({runConfig: {customMetadata: {tenant: 'other'}}});
clone.customMetadata === context.customMetadata; // true
```

That is what makes a sub-agent's write visible to the parent, and it is why the
new run config's keys are ignored. Set the metadata on the run config that
starts the invocation.

## Realtime audio caches

Both caches are `undefined` until something assigns an array, matching
`adk-python`, whose audio cache manager assigns `[]` lazily and reassigns `[]`
on each flush. A `RealtimeCacheEntry` needs all three of its fields:

```ts
import {RealtimeCacheEntry} from '@google/adk';

const entry: RealtimeCacheEntry = {
  role: 'user',
  data: {mimeType: 'audio/pcm', data: audioBase64},
  timestamp: Date.now() / 1000,
};

context.inputRealtimeCache ??= [];
context.inputRealtimeCache.push(entry);
```

`timestamp` is seconds since the Unix epoch, not milliseconds. It matches
`adk-python`'s `time.time()`, so a value written by either SDK means the same
thing. Produce it as `Date.now() / 1000`.

## Background tool tasks

A live run starts a non-blocking tool as a detached `Task` and registers it
under `<toolName>_<functionCallId>`:

```ts
import {Task} from '@google/adk';

context.activeNonBlockingToolTasks ??= {};
context.activeNonBlockingToolTasks[`${tool.name}_${functionCall.id}`] = task;
```

The registry is shared by every context of the invocation, so the task can
delete its own key when it finishes while the flow still holds the map. Call
`task.cancel()` to stop a task that is still running.
