# A2AAgentExecutor

`A2AAgentExecutor` runs an ADK agent for one Agent2Agent (A2A) request and
publishes the run as A2A events. Reach for it when you serve an agent over A2A
and need to control how a request maps onto a user and a session, what the
server publishes for each ADK event, or how the task terminates. `toA2a` builds
one for you with the defaults.

## Introduction

The `@a2a-js/sdk` server calls an `AgentExecutor` for every task: `execute` for a
new message, and `cancelTask` when a client cancels. `A2AAgentExecutor`
implements that interface on top of an ADK `Runner`. `toA2a` builds one for you
with defaults, and that is the right entry point when the defaults fit.

Construct the executor yourself when they do not. Four seams are open:

- A **request converter** decides the user id, the session id and the message
  the runner receives. The default derives the user from the authenticated
  principal on the call context, or from the context id when the request is
  anonymous.
- **Part converters** decide how one A2A part becomes GenAI parts, and back.
- **Event converters** decide which A2A events one ADK event produces. Two
  slots hold one, and the default produces a single artifact update carrying
  the event's parts.
- **Interceptors** decide what actually reaches the event bus. Unlike the
  executor's callbacks, an interceptor can replace the request context, expand
  one event into several, drop an event, and rewrite the terminal event.

The executor also aggregates what the run published. If any published status
update reported `failed`, `auth-required` or `input-required`, the task settles
on the most severe of them and the terminal event carries that state and its
message. Every intermediate status update is rewritten to a non-terminal
`working` update first, because a terminal intermediate event ends the client's
stream before the real result arrives.

## Get started

```ts
import {DefaultRequestHandler, InMemoryTaskStore} from '@a2a-js/sdk/server';
import {
  A2AAgentExecutor,
  getA2AAgentCard,
  InMemorySessionService,
  LlmAgent,
} from '@google/adk';

const agent = new LlmAgent({
  name: 'greeter',
  model: 'gemini-2.0-flash',
  instruction: 'Greet the caller.',
});

const executor = new A2AAgentExecutor({
  runner: {
    agent,
    appName: agent.name,
    sessionService: new InMemorySessionService(),
  },
});

const agentCard = await getA2AAgentCard(agent, [
  {url: 'http://localhost:8000/a2a/jsonrpc', transport: 'JSONRPC'},
]);
const handler = new DefaultRequestHandler(
  agentCard,
  new InMemoryTaskStore(),
  executor,
);
```

`toA2a` does this for you and mounts the Express routes. Build the executor
yourself when you need the configuration below, which `toA2a` does not expose.

## The event stream

For a task the client does not yet hold, `execute` publishes, in order:

1. a `Task` with state `submitted`;
2. a non-final `working` status update carrying the app, user and session ids;
3. the converted events, each non-final and `working`;
4. optionally one `TaskArtifactUpdateEvent` with `lastChunk: true`;
5. exactly one status update with `final: true`.

Step 4 happens when nothing settled the task and the aggregated status message
has parts. Those parts are republished as the final artifact, so a client that
reads only artifacts still receives the answer, and the task then closes as
`completed`. When something did settle the task, no artifact update is
published and the terminal event carries the settled state and its message.

The terminal event's metadata carries the app, user and session ids, plus the
last ADK event's invocation id, author and event id.

## Attribute runs to an authenticated principal

Behind an authenticating A2A server, the default converter already uses
`requestContext.context.user.userName`. Otherwise the run is anonymous:

```ts
import {getUserId} from '@google/adk';

// `A2A_USER_<contextId>` when the server has no authentication wired up,
// otherwise `requestContext.context.user.userName`.
const userId = getUserId(requestContext);
```

Supply your own converter when the user or the session comes from somewhere
else:

```ts
import {A2AAgentExecutor, toGenAIContent} from '@google/adk';

const executor = new A2AAgentExecutor({
  runner: myRunner,
  requestConverter: (request, partConverter) => ({
    userId: `tenant:${request.contextId}`,
    sessionId: request.contextId,
    newMessage: toGenAIContent(request.userMessage, partConverter),
  }),
});
```

The converter's second argument is the configured `a2aPartConverter`, so a
custom converter can still reuse the part conversion. The converter's
`runConfig` is merged over the executor's own `runConfig`, so it can raise or
lower per-request limits.

The session id the converter returns is the session the executor gets or
creates. When the executor has to create it, the service can assign an id of its
own, and the run addresses the session that now exists rather than the one that
was asked for.

## Converter slots and their defaults

Every executor holds a converter for each direction of the boundary:

| Field                | Converts                               | Default                                    |
| -------------------- | -------------------------------------- | ------------------------------------------ |
| `a2aPartConverter`   | one inbound A2A part into GenAI parts  | `toGenAIPart`                              |
| `genAiPartConverter` | one outbound GenAI part into A2A parts | `toA2APart`                                |
| `adkEventConverter`  | one ADK event into A2A events          | `toA2AArtifactUpdateEventsFromArtifactMap` |

`resolveA2aAgentExecutorConfig` applies those defaults, and the executor calls
it in its constructor. It resolves the whole set once, so a config the
executor accepts cannot fail later in the middle of a live stream.

`adkEventConverter` is the counterpart of `adk_event_converter` on
adk-python's `A2aAgentExecutorConfig`: it takes the ADK event, the artifact map
of the execution in progress, the task id, the context id and the part
converter. The `eventConverter` slot takes the whole executor context instead,
and takes precedence over `adkEventConverter` when both are set.

The executor stamps ADK metadata — the app, user and session ids, the
invocation id, the author, the branch — onto every event a converter returns. A
converter does not have to reproduce it.

```ts
import {
  A2AAgentExecutor,
  toA2AArtifactUpdateEventsFromArtifactMap,
} from '@google/adk';

const executor = new A2AAgentExecutor({
  runner: myRunner,
  adkEventConverter: (
    adkEvent,
    agentsArtifacts,
    taskId,
    contextId,
    genAiPartConverter,
  ) => {
    if (adkEvent.author === 'internal_auditor') {
      return [];
    }
    return toA2AArtifactUpdateEventsFromArtifactMap(
      adkEvent,
      agentsArtifacts,
      taskId,
      contextId,
      genAiPartConverter,
    );
  },
});
```

Returning an empty array publishes nothing for that ADK event.

### The artifact map

`adkEventConverter` receives a `Map` from an event author to the artifact id
that author is streaming into. The built-in converter reads it to give every
chunk of one response the same artifact id, and deletes the entry when the
final chunk arrives. A converter may mutate the map.

The executor creates one map per `execute` call, so two concurrent requests on
one executor never write into each other's artifact.

### Validation errors

A slot that is present and is not a function is rejected where the executor is
constructed:

```ts
// TypeScript rejects this literal at compile time. A value that reaches the
// config from untyped JavaScript is rejected here instead:
new A2AAgentExecutor({runner, genAiPartConverter: 'nope'});
// Error: A2A executor config field "genAiPartConverter" must be a function,
//        received string
```

`undefined` selects the default. `null` is a supplied value of the wrong type
and is rejected. The message names the field, and with several wrong fields it
names the first one in the order listed above.

## Rewrite what the server publishes

An interceptor sees each converted event with the executor context and the ADK
event that produced it. Return an array to publish several events, or
`undefined` to publish none:

```ts
import {A2AAgentExecutor, ExecuteInterceptor} from '@google/adk';

const auditInterceptor: ExecuteInterceptor = {
  afterEvent: async (ctx, event, adkEvent) => {
    if (adkEvent.partial) {
      return undefined;
    }
    return [event, buildAuditEvent(ctx, adkEvent)];
  },
};

const executor = new A2AAgentExecutor({
  runner: myRunner,
  executeInterceptors: [auditInterceptor],
});
```

`beforeAgent` hooks run in registration order and each one sees the previous
one's context. `afterAgent` hooks run in reverse order, so the interceptor
registered first has the last word on the terminal event.

## Cancellation

`cancelTask` publishes one terminal `canceled` status update for the task. The
request handler drains events until it sees a terminal state, so an executor
that publishes nothing there never completes the client's call.

The cancellation also stops the run. The executor gives each execution an
`AbortController` and passes its signal to `runner.runAsync`, so the run ends at
the runner's next abort checkpoint. The execution then publishes no terminal
event of its own. The `canceled` update is the terminal one, and a `completed`
or `failed` event after it makes the request handler reject the cancellation it
has already accepted.

One limit is worth knowing. The executor can only cancel a task it is running
right now. It holds one entry per in-flight execution, and throws for a task id
it does not hold.

## Failure handling

A request with no message, task id or context id rejects the returned promise
and publishes nothing: there is no task to report a failure against. The
executor checks this before it runs a `beforeAgent` interceptor, and again on
the context that interceptor returned.

Every failure after that point — runner resolution, request conversion, session
creation, the run, event conversion, an interceptor — is logged and published as
a terminal `failed` status update whose text reads
`Agent run failed: <message>`. A throwing `afterExecuteCallback` is logged and
swallowed, and the terminal event is still published.
