# RemoteA2AAgent

`RemoteA2AAgent` makes an agent that runs somewhere else look like a local
sub-agent. It resolves the peer's agent card, opens an A2A client, forwards the
part of the conversation the peer has not seen, and turns the peer's reply back
into ADK events. Reach for it when the work belongs to a team, a language or a
deployment that is not yours.

## Introduction

An ADK agent tree is a single process. A sub-agent is an object you construct,
and a transfer to it is a function call. `RemoteA2AAgent` keeps that shape while
the agent itself runs behind an HTTP endpoint speaking the
[A2A protocol](https://a2a-protocol.org/). The parent agent still sees one
sub-agent with a name and a description, and still transfers to it the same way.

That boundary is what the rest of this guide is about. Three things change once
an agent is remote:

- **The peer is not trusted.** Its agent card names the URL your client will
  send the user's request to, and its description lands in the parent agent's
  instruction. Both are checked before they are used.
- **Credentials have to travel.** A remote agent behind OAuth2 or an API key
  needs the credential on the request, and the agent has to be able to ask the
  client for one it does not have.
- **The call can fail or hang.** A local sub-agent cannot; a network peer can.

`toA2a()` is the other half of the same picture: it exposes one of your agents
over A2A so somebody else's `RemoteA2AAgent` can reach it.

## Get started

```ts
import {LlmAgent, RemoteA2AAgent} from '@google/adk';

const bookingAgent = new RemoteA2AAgent({
  name: 'booking_agent',
  agentCard: 'https://booking.example.com',
});

const coordinator = new LlmAgent({
  name: 'coordinator',
  model: 'gemini-2.0-flash',
  instruction: 'Transfer booking requests to booking_agent.',
  subAgents: [bookingAgent],
});
```

`agentCard` accepts three things: a URL, a local file path, or an `AgentCard`
object you already have. A URL is treated as a base URL — the client fetches
`/.well-known/agent-card.json` under it.

## Authentication

Set `authScheme` and the agent resolves a credential once per invocation and
sends it on both the card request and the message send.

```ts
import {AuthCredentialTypes, RemoteA2AAgent} from '@google/adk';

const bookingAgent = new RemoteA2AAgent({
  name: 'booking_agent',
  agentCard: 'https://booking.example.com',
  authScheme: {type: 'apiKey', in: 'header', name: 'X-Api-Key'},
  authCredential: {
    authType: AuthCredentialTypes.API_KEY,
    apiKey: process.env.BOOKING_API_KEY,
  },
});
```

When no credential is available — an OAuth2 scheme with nothing exchanged yet —
the agent emits one `adk_request_credential` event, marks it long-running, and
ends the invocation. The client collects the credential, and the next turn
resolves it from session state and proceeds. Nothing is sent to the peer in the
meantime.

The resolved credential never reaches session state. It lives in a local for
the length of the run and goes out as request headers.

`credentialKey` names the state key the collected credential is read from. It
defaults to `adk_a2a_<agent name>`, so two remote agents sharing one scheme do
not share a credential.

## What is checked before the peer is trusted

Every RPC URL on a card fetched over the network must be `https`, or `http` on a
loopback host, and must share the origin the card came from. A card that points
somewhere else fails with `AgentCardResolutionError` and no request is sent
there.

```ts
import {
  isAgentCardResolutionError,
  resolveAgentCard,
  validateAgentCard,
} from '@google/adk';

const source = 'https://booking.example.com';
try {
  const card = await resolveAgentCard(source);
  validateAgentCard(card, source);
} catch (e: unknown) {
  if (isAgentCardResolutionError(e)) {
    // The card named a host it is not allowed to name.
  }
}
```

A card supplied directly or read from a local file is your own text and is not
origin-checked.

The description on a network-fetched card is capped at 1024 characters and
fenced between `<<<BEGIN_QUOTED_AGENT_CONTENT>>>` markers before the agent
adopts it, because a parent agent interpolates a transfer target's description
straight into its own instruction. An explicit `description` is never
overwritten.

Credential material is stripped from the conversation before it is forwarded. A
serialized `AuthConfig` in a function call's arguments or in a function
response is dropped, unless the peer itself raised that request.

## Deadlines and cancellation

`timeoutMs` bounds the card request and the remote call. It defaults to
600000 ms, matching adk-python. The invocation's own abort signal cancels the
request too, whichever fires first.

```ts
const bookingAgent = new RemoteA2AAgent({
  name: 'booking_agent',
  agentCard: 'https://booking.example.com',
  timeoutMs: 30_000,
});
```

`close()` releases the card and the client the agent resolved. A client or a
`fetchImpl` you supplied is left alone — the agent never owned it — and calling
`close()` twice is a no-op.

## Interceptors

A `requestInterceptor` sees every outgoing message and every converted response.
Use it to trace a call, add a header, or refuse one, rather than subclassing the
agent.

```ts
import {A2ARequestInterceptor} from '@google/adk';

const addTraceHeader: A2ARequestInterceptor = {
  beforeRequest: async (_ctx, request, params) => ({
    request,
    params: {...params, headers: {...params.headers, 'X-Trace': 'abc'}},
  }),
};
```

Returning an ADK event from `beforeRequest` in place of the request aborts the
call and emits that event instead. `afterRequest` hooks run in reverse list
order, and returning `undefined` drops the event.

`cardRequestInterceptors` do the same for the agent card request. Configuring
one makes the card per-invocation: it is fetched with that invocation's headers
and is not cached, because an authenticated card is scoped to one session.

## History sent to the peer

By default the agent forwards only what the peer has not seen: it walks back
through the session and stops at the peer's last reply. A peer that never
returns a context id keeps no state of its own, so set
`fullHistoryWhenStateless: true` and the whole session goes out on every
request. Parts from user-authored events carry `is_user_input: true` so the peer
can tell them from relayed agent output.

## Converters

`genaiPartConverter` and `a2aPartConverter` replace the default translation
between GenAI parts and A2A parts. A converter that returns `undefined` drops
the part, and the agent logs a warning and sends the rest.

```ts
import {RemoteA2AAgent, toA2APart} from '@google/adk';

const bookingAgent = new RemoteA2AAgent({
  name: 'booking_agent',
  agentCard: 'https://booking.example.com',
  genaiPartConverter: (part) => (part.inlineData ? undefined : toA2APart(part)),
});
```

## Delegating a whole task

`mode: 'task'` runs the agent as a task sub-agent: it owns the exchange with
the peer until the peer says the task is done, then hands control back.

```ts
import {RemoteA2AAgent} from '@google/adk';
import {Type} from '@google/genai';

const bookingAgent = new RemoteA2AAgent({
  name: 'booking_agent',
  agentCard: 'https://booking.example.com',
  mode: 'task',
  outputSchema: {
    type: Type.OBJECT,
    properties: {reference: {type: Type.STRING}},
    required: ['reference'],
  },
});
```

The peer must call the `finish_task` tool to signal completion. An ADK
task-mode agent does that natively; a custom A2A server must return a function
response named `finish_task` whose `result` is `'Task completed.'` or
`'Task failed.'`. Set `outputSchema` to mirror the remote agent's, so the
arguments are unwrapped the same way: an object schema puts them at the top
level of `event.output`, and any other schema wraps the value under `result`.

Three things change in this mode:

* **History is scoped to the task.** When the invocation carries an isolation
  scope, only events in that scope are forwarded, plus the coordinator's
  function call whose id is the scope — that call carries the task's inputs.
  A sibling call the coordinator aimed at another tool is dropped, and a
  function response answering a call the peer never made is relayed as text,
  because the peer has no invocation to resume for it. An isolation scope that
  no function call opened is rejected: a workflow path scope is not a task
  scope.
* **The whole scope is sent every turn**, since the scope is new to the peer.
* **Control always comes back.** Every terminating path — an auth failure, a
  card that will not resolve, an empty message, a transport error, a task the
  peer reported `failed` or `canceled` — emits a failing `finish_task`
  response and then an event with `actions.endOfAgent`, so the coordinator is
  never left waiting. A credential request is the exception: it is a pause, so
  the task keeps its control and resumes on the next turn.

## As a workflow node

Running a `RemoteA2AAgent` inside a `Workflow` promotes the peer's answer text
to `event.output`, so a `JoinNode` aggregating parallel remote predecessors sees
a value for each. Promotion happens once, on the first terminal event. Events
carrying an in-progress task state (`submitted`, `working`, `input-required`,
`auth-required`, `unknown`) and partial streaming chunks pass through untouched.

## Errors

| What happened                                                 | What you get                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------- |
| The card is unreachable, malformed, or aims at another origin | one error event, `Failed to initialize remote A2A agent: …`   |
| The credential cannot be resolved and cannot be requested     | one error event, `Failed to authenticate remote A2A agent: …` |
| The transport fails                                           | one error event, `A2A request failed: …`                      |
| Nothing is left to send after scrubbing                       | one event with empty content, and no request                  |

Live (bidirectional) mode is not implemented; `runLive` rejects.
