# A2AAgentExecutor

`A2AAgentExecutor` runs an ADK agent for one inbound Agent2Agent (A2A) request
and publishes the run as A2A events. Reach for it when you mount an agent
yourself with `@a2a-js/sdk`, or when you need to change how a request maps onto
a run. `toA2a` builds one for you with the defaults.

## Introduction

An A2A server speaks in tasks, status updates and artifacts. An ADK run speaks
in events. The executor sits between the two: it converts the inbound message
into runner arguments, runs the agent, converts each ADK event into A2A events,
and closes the task with exactly one terminal status update.

Four seams let a deployment change that translation without forking the
executor:

- `requestConverter` decides the user id, the session id and the message.
- `a2aPartConverter` and `genAiPartConverter` decide how one part crosses the
  boundary in each direction.
- `eventConverter` decides which A2A events one ADK event becomes.
- `executeInterceptors` can rewrite the request, expand or drop an outbound
  event, and rewrite the terminal event.

The terminal state comes from the status updates the run published, not from
the last event to arrive. `TaskResultAggregator` applies the precedence
`failed` > `auth-required` > `input-required` and rewrites every intermediate
event to a non-final `working` update. Without that rewrite an intermediate
terminal state ends the client's stream before the real answer arrives.

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

## Attributing a run to a caller

The default request converter reads the authenticated principal from the call
context, and falls back to a name derived from the context id:

```ts
import {getUserId} from '@google/adk';

// `A2A_USER_<contextId>` when the server has no authentication wired up,
// otherwise `requestContext.context.user.userName`.
const userId = getUserId(requestContext);
```

Supply your own converter to decide otherwise:

```ts
const executor = new A2AAgentExecutor({
  runner,
  requestConverter: (request) => ({
    userId: 'principal@example.com',
    sessionId: `session-of-${request.contextId}`,
    newMessage: {role: 'user', parts: [{text: 'converted'}]},
  }),
});
```

The converter's second argument is the configured `a2aPartConverter`, so a
custom converter can still reuse the part conversion.

The session id the converter returns is the session the executor gets or
creates. The run itself uses the resolved session's id.

## Rewriting events

An interceptor can replace one converted event with several, or drop it by
returning `undefined`:

```ts
const executor = new A2AAgentExecutor({
  runner,
  executeInterceptors: [
    {
      // Drop every artifact update, so the client sees status updates only.
      afterEvent: async (_ctx, event) =>
        event.kind === 'artifact-update' ? undefined : event,
      afterAgent: async (_ctx, finalEvent) => finalEvent,
    },
  ],
});
```

`beforeAgent` hooks run in registration order, each seeing the previous one's
returned context. `afterAgent` hooks run in reverse order, so the interceptor
registered first has the last word on the terminal event.

## Cancellation

`cancelTask` publishes the terminal `canceled` status update the A2A
cancellation contract requires. It throws when the task id is empty, and when
this executor has no execution in flight for that id.

The run itself is not interrupted. adk-js cannot abort an invocation in
flight, so the agent finishes and its own terminal event follows the
cancellation.

## Failure handling

A request with no message, task id or context id rejects the returned promise
and publishes nothing: there is no task to report a failure against.

Every failure after that point — runner resolution, request conversion, session
creation, the run, event conversion, an interceptor — is logged and published
as a terminal `failed` status update whose text reads
`Agent run failed: <message>`. A throwing `afterExecuteCallback` is logged and
swallowed, and the terminal event is still published.
