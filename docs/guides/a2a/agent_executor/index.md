# A2AAgentExecutor

`A2AAgentExecutor` runs an ADK agent for one Agent2Agent (A2A) request and
publishes the run as A2A events. Reach for it when you serve an agent over A2A
and need to control how a request maps onto a user and a session, what the
server publishes for each ADK event, or how the task terminates.

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
- An **event converter** decides which A2A events one ADK event produces. The
  default produces a single artifact update carrying the event's parts.
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
import {A2AAgentExecutor, InMemorySessionService, LlmAgent} from '@google/adk';

const executor = new A2AAgentExecutor({
  runner: {
    agent: new LlmAgent({name: 'greeter', model: 'gemini-2.0-flash'}),
    appName: 'greeter',
    sessionService: new InMemorySessionService(),
  },
});
```

Pass the executor to the `@a2a-js/sdk` request handler you already use. For the
default wiring — an Express app, an agent card and an in-memory session service
— call `toA2a(agent, {...})` instead and skip the executor entirely.

## Attribute runs to an authenticated principal

Behind an authenticating A2A server, the default converter already uses
`requestContext.context.user.userName`. Supply your own converter when the user
or the session comes from somewhere else:

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

The converter's `runConfig` is merged over the executor's own `runConfig`, so it
can raise or lower per-request limits.

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
