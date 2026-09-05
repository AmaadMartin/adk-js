# RemoteA2AAgent converters and interceptors

`RemoteA2AAgentConfig` lets you replace how an A2A response becomes an ADK
event, and lets you observe or change a request on its way out. Reach for it
when the remote needs a header the agent cannot know at construction time, or
when the default conversion does not produce the events your app expects.

## Introduction

`RemoteA2AAgent` does three things per turn. It fetches the remote agent card,
it sends one A2A message, and it converts each response frame into an ADK
event. Each of those three steps has a seam.

- **Card-request interceptors** supply HTTP headers for the card fetch. The
  hook receives the `InvocationContext`, so the header can come from session
  state. This is the seam to use for a remote behind an authenticating proxy.
- **Request interceptors** run around the message send. `beforeRequest` can
  rewrite the outgoing message, attach request metadata, add headers, or abort
  the send entirely. `afterRequest` sees each converted event and can replace
  or drop it.
- **Converter slots** replace one branch of the response conversion. There is
  one slot per A2A frame kind, plus a part-level slot the other four are handed.

The seams are independent and every field is optional. A config that sets none
of them behaves exactly as before.

`beforeRequestCallbacks` and `afterRequestCallbacks` still exist and still run.
They are observers: they can mutate `MessageSendParams` but cannot abort a send
or replace an event. Use an interceptor when you need either of those.

## Get started

Add a bearer token to the agent card fetch, read out of session state:

```ts
import {A2ACardRequestInterceptor, RemoteA2AAgent} from '@google/adk';

const authHeader: A2ACardRequestInterceptor = {
  async beforeRequest(ctx) {
    return {headers: {authorization: `Bearer ${ctx.session.state['token']}`}};
  },
};

const agent = new RemoteA2AAgent({
  name: 'remote_agent',
  agentCard: 'https://example.com',
  cardRequestInterceptors: [authHeader],
});
```

## Card-request interceptors

The hooks run in list order and their headers merge, so a later interceptor
wins a conflicting key. A hook with no `beforeRequest` is skipped.

They are consulted only for an `http(s)` card source. A card object and a file
path never reach the network, so a card interceptor configured alongside one
never runs.

Configuring a card interceptor changes when the card is fetched. Without one,
the agent fetches the card once and caches it. With one, the agent re-resolves
the card on every invocation, because the headers are per-invocation and the
A2A specification scopes an authenticated card to a single authenticated
session. One session's card is never served to another.

## Request interceptors

`beforeRequest` receives the message and the parameters built so far, and
returns both. Returning an ADK `Event` as the `request` aborts the send: the
agent yields that event and never contacts the remote.

```ts
import {A2ARequestInterceptor, createEvent} from '@google/adk';

const budgetGuard: A2ARequestInterceptor = {
  async beforeRequest(ctx, request, params) {
    if (ctx.session.state['budgetExhausted']) {
      return {
        request: createEvent({
          author: 'budget_guard',
          invocationId: ctx.invocationId,
          errorMessage: 'budget exhausted',
        }),
        params,
      };
    }
    return {request, params: {...params, requestMetadata: {tenant: 'acme'}}};
  },
};
```

`params.requestMetadata` lands on `MessageSendParams.metadata`. `params.headers`
are passed as `RequestOptions.serviceParameters`, on both the streaming and the
non-streaming send.

`afterRequest` runs in **reverse** list order, so the interceptor that shaped
the request last sees the response first. Returning `undefined` drops the
event, and no later hook runs for that frame.

A hook that rejects is not swallowed. The agent's existing error handling turns
it into an error event, the same as any other failure during a turn.

## Converter slots

Each slot owns the whole conversion for one A2A frame kind:

| Field                        | Frame                              |
| ---------------------------- | ---------------------------------- |
| `a2aMessageConverter`        | `Message`                          |
| `a2aTaskConverter`           | `Task`                             |
| `a2aStatusUpdateConverter`   | `TaskStatusUpdateEvent`            |
| `a2aArtifactUpdateConverter` | `TaskArtifactUpdateEvent`          |
| `a2aPartConverter`           | one `Part` inside any of the above |

An omitted slot uses the built-in converter. A converter that returns
`undefined` emits no event for that frame; the run continues.

The four frame-level converters receive the part converter as their last
argument, so an override can reuse it instead of hardcoding the default:

```ts
import {A2AMessageToEventConverter, createEvent} from '@google/adk';

const messageConverter: A2AMessageToEventConverter = (
  message,
  invocationId,
  author,
  branch,
  partConverter,
) =>
  createEvent({
    author,
    invocationId,
    branch,
    content: {
      role: 'model',
      parts: message.parts.flatMap((p) => partConverter(p) ?? []),
    },
  });
```

The part converter may also drop a part by returning `undefined`, or expand one
into several by returning an array.

## Cloning

`clone()` carries converters and interceptors across by reference, so a cloned
agent calls the same function objects the original was given.
