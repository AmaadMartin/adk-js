# InvocationContext

The object every agent, flow and tool reads during one run. It carries the
session, the services, the run configuration, and the bookkeeping a run needs to
select its own events, pause on a long-running tool, and resume later.

## Introduction

An invocation starts with a user message and ends with a final response. Along
the way the runner builds a tree of contexts: the root agent gets one, each
sub-agent gets a copy with its own `agent` and `branch`, and a tool that runs a
node gets another. `InvocationContext.clone()` makes those copies. It copies own
fields, so scalars decouple and objects stay shared — which is why the LLM-call
counter, the agent-state records and the session are the same for the whole
invocation.

Five groups of behaviour live here rather than in the agents:

- **Event selection.** `getEvents()` answers "which of the session's events are
  mine?", by invocation, by branch, or both. Parallel sub-agents share one
  session, so the branch rule is what stops one tree reading another's events.
- **Resumability.** `agentStates` and `endOfAgents` record where each agent got
  to. `shouldPauseInvocation()` decides whether a long-running tool call stops
  the run, and `populateInvocationAgentStates()` rebuilds the records from
  session history when the run restarts.
- **Limits.** `incrementLlmCallCount()` enforces `runConfig.maxLlmCalls` across
  the whole invocation, not per agent.
- **Run-wide state.** `credentialService` is the service a tool resolves a
  credential against. `stateSchema` declares which session-state keys the run
  may write, and their types.
- **Shared slots.** `customMetadata` carries request-scoped values for tools and
  services. `inputRealtimeCache`, `outputRealtimeCache` and
  `activeNonBlockingToolTasks` hold what a live run buffers and cancels.

You rarely construct one. The runner does that, and hands it to your agent's
`runAsyncImpl`, to callbacks, and to tools through `ToolContext`.

## Get started

An agent reads its own history through `getEvents`. Ask for
`currentInvocation` to exclude earlier turns, and `currentBranch` to exclude
the events of parallel siblings.

```ts
import {BaseAgent, Event, InvocationContext, createEvent} from '@google/adk';

class HistorySizeAgent extends BaseAgent {
  protected async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const mine = ctx.getEvents({currentInvocation: true, currentBranch: true});

    yield createEvent({
      author: this.name,
      content: {role: 'model', parts: [{text: `${mine.length} events so far`}]},
    });
  }

  protected async *runLiveImpl(
    _ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
}
```

With neither option, `getEvents()` returns the session's events untouched.

## Branch selection

`currentBranch` treats user events and agent events differently, on purpose.

A user event matches when it sits on this branch, on a descendant sub-branch, or
on no branch. Any other event must sit on exactly this branch: a descendant's
own agent events stay private to it. So the user's answer to a confirmation
reaches the agent that asked for it, while the sub-agent's internal steps do
not.

A user event that carries function responses has one more test to pass. Its
responses must answer a call issued on this branch or below it. A reply that
answers a parallel tree's call is dropped even when it sits on exactly this
branch, which is what stops one branch consuming another's answer.

An empty-string branch is a real branch value, not a synonym for "no branch". A
scope with `branch: ''` matches no branched event. A scope with no branch at all
matches every user event.

The same rule is available on its own as `filterSessionEvents`, for code that
holds a list of events rather than a context.

## Resumability

Resumability is off unless the invocation carries a `ResumabilityConfig` that
enables it. `isResumable` reports the result.

```ts
import {InvocationContext, createResumabilityConfig} from '@google/adk';

function prepare(ctx: InvocationContext): boolean {
  ctx.resumabilityConfig = createResumabilityConfig({isResumable: true});
  ctx.populateInvocationAgentStates();
  return ctx.isResumable;
}
```

`populateInvocationAgentStates()` walks this invocation's events and rebuilds
`agentStates` and `endOfAgents` from them: an event marking the end of an agent
sets the flag and drops the state, an event carrying a state records it, and an
authored event with content but no state records an empty state so a resumed run
knows the agent already started. It does nothing when the invocation is not
resumable.

Agents record their own progress with `setAgentState`, which has three
behaviours in one call:

```ts
import {InvocationContext} from '@google/adk';

function recordProgress(ctx: InvocationContext): void {
  ctx.setAgentState('researcher', {agentState: {step: 2}}); // record progress
  ctx.setAgentState('researcher', {endOfAgent: true}); // done; state dropped
  ctx.setAgentState('researcher'); // forget both; the agent may run again
}
```

`resetSubAgentStates('researcher')` applies the third form to every agent below
`researcher`, so a re-run starts its children fresh. The named agent keeps its
own state.

## Pausing on a long-running tool

`shouldPauseInvocation(event)` returns true when `event` issues a function call
listed in its own `longRunningToolIds` and nothing has answered it yet. "Nothing
has answered it" means no later user event sits on a branch spawned by that
call — a branch segment of the form `name@<callId>`. Pausing does not depend on
`isResumable`; adk-python pauses on a long-running call whatever the app's
resumability setting, and this matches.

Pausing is not ending. A paused invocation can be resumed; an ended one cannot.

## Matching a function response to its call

`findMatchingFunctionCall(event)` returns the event in this invocation that
issued the call `event` answers, and `stampEventBranchContext(event)` copies
that call's branch onto the response. The branch is overwritten, because a
response belongs wherever its call was issued. The isolation scope is only
filled in when the response has none, because a response already inside an
active task must stay in it.

## The LLM-call limit

`incrementLlmCallCount()` throws `LlmCallsLimitExceededError` once the
invocation has made more than `runConfig.maxLlmCalls` calls. The counter is
shared with every context `clone()` produced, so the limit bounds the run rather
than one agent. A limit of zero or less is not enforced.

```ts
import {InvocationContext, isLlmCallsLimitExceededError} from '@google/adk';

function countCall(ctx: InvocationContext): boolean {
  try {
    ctx.incrementLlmCallCount();
    return true;
  } catch (error: unknown) {
    if (isLlmCallsLimitExceededError(error)) {
      return false; // The run hit its budget.
    }
    throw error;
  }
}
```

Use `isLlmCallsLimitExceededError` rather than `instanceof`: two copies of
adk-js in one runtime hold two different classes, and `instanceof` returns
false between them.

## The credential service

`credentialService` is the service the `Runner` was built with. A tool that
exchanges a credential reads it from the invocation rather than taking its own.
The field reaches a cloned context, so a sub-agent resolves credentials against
the same service as its parent.

## The state schema

`stateSchema` declares which session-state keys the run may write, and their
types. `Context` hands it to the `State` it builds, so an undeclared write
raises `StateSchemaError` instead of landing silently. Declare a schema on the
invocation and every state write in the run is checked against it.

```ts
import {
  Context,
  InvocationContext,
  LlmAgent,
  PluginManager,
  createSession,
  isStateSchemaError,
} from '@google/adk';
import {z} from 'zod/v4';

const invocationContext = new InvocationContext({
  invocationId: 'inv-1',
  agent: new LlmAgent({name: 'agent', model: 'gemini-2.0-flash'}),
  session: createSession({
    id: 's1',
    appName: 'app',
    userId: 'u',
    lastUpdateTime: Date.now(),
  }),
  pluginManager: new PluginManager(),
  stateSchema: z.object({counter: z.number()}),
});

const context = new Context({invocationContext});

context.state.set('counter', 1); // Declared, and the type matches.

try {
  context.state.set('countr', 1); // A typo the schema does not declare.
} catch (err: unknown) {
  isStateSchemaError(err); // true
}
```

With no `stateSchema`, nothing is checked and any key is accepted. That is the
default, so adding a schema is opt-in.

### What the schema checks

A write is rejected when the key is not declared, and when the value does not
match the declared type. The error is a `StateSchemaError`, and its message
names the declared fields so the fix is visible.

Keys carrying a namespace prefix — `app:`, `user:`, `temp:`, or any other
`name:` form — are exempt. They belong to a scope wider than this session's
state, so the invocation's schema has no authority over them.

A workflow node that declares its own `stateSchema` uses that one. The
invocation's schema applies where no node declares one, which is every ordinary
agent, callback and tool.

`ReadonlyContext` carries the schema onto the read-only view it hands out, so a
holder that inspects the view sees the same schema. The view rejects every write
with a `ReadonlyStateError` first, so the schema never has to reject one. See
[ReadonlyContext](../readonly_context/index.md).

### Cloning and lifetime

Both fields reach a cloned context, so a sub-agent resolves credentials against
the same service and writes under the same schema as its parent.

```ts
const child = invocationContext.clone({agent: subAgent});

child.credentialService === invocationContext.credentialService; // true
child.stateSchema === invocationContext.stateSchema; // true
```

Both mirror `InvocationContext` in
[google/adk-python](https://github.com/google/adk-python), where the schema is
the private `_state_schema`.

## Invocation-scoped shared slots

Three more slots hold state that every context of one invocation shares: the
custom metadata record, the realtime audio caches, and the background tool-task
registry. Children are copies, so a field only survives the whole run if the
constructor carries it over by reference. These three do exactly that: a write
through any context of the invocation is visible on every other one.

### Custom metadata

`customMetadata` is the slot a host application reaches for. Set
`RunConfig.customMetadata` on the run, and the context exposes a mutable copy
of it that tools and services can read and extend. Use it for values that
belong to the request rather than to the conversation — a tenant id, a trace
correlation id, a debug flag. Session state is the wrong place for those,
because it persists past the run.

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

### Realtime audio caches

`inputRealtimeCache` and `outputRealtimeCache` buffer audio chunks before a
flush to the artifact service. `AudioCacheManager` writes to them, and they
match the shape `adk-python` uses.

Both caches are `undefined` until something assigns an array, matching
`adk-python`, whose audio cache manager assigns `[]` lazily and reassigns `[]`
on each flush. A `RealtimeCacheEntry` needs all three of its fields:

```ts
import {RealtimeCacheEntry} from '@google/adk';

const entry: RealtimeCacheEntry = {
  role: 'user',
  data: {mimeType: 'audio/pcm', data: audioBase64},
  timestamp: Date.now(),
};

context.inputRealtimeCache ??= [];
context.inputRealtimeCache.push(entry);
```

`timestamp` is milliseconds since the Unix epoch, not seconds. It matches an
`adk-js` event timestamp, because `AudioCacheManager` copies the value onto the
event it emits for the flushed artifact. `adk-python` stores seconds here,
because its own events use seconds.

### Background tool tasks

A live run starts a non-blocking tool as a detached `Task` and registers it
under `<toolName>_<functionCallId>`, so the flow can cancel it when the run
ends:

```ts
import {Task} from '@google/adk';

context.activeNonBlockingToolTasks ??= {};
context.activeNonBlockingToolTasks[`${tool.name}_${functionCall.id}`] = task;
```

The registry is shared by every context of the invocation, so the task can
delete its own key when it finishes while the flow still holds the map. Call
`task.cancel()` to stop a task that is still running.
