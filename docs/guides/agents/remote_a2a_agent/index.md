# RemoteA2AAgent

`RemoteA2AAgent` runs a remote agent over the Agent2Agent (A2A) protocol as if
it were a local sub-agent. Reach for it when the work belongs to a service you
do not run in this process: another team's agent, a partner's endpoint, or a
model host behind its own credentials.

## Introduction

An A2A peer is another process. Three things follow from that, and this agent
handles all three.

The peer is not trusted. Its agent card decides where the client sends traffic,
and its description lands in the parent agent's transfer instruction. A card
fetched over the network must therefore aim every RPC URL at the origin it came
from, over `https` (or `http` on a loopback host), and its description is capped
and fenced before the parent adopts it.

The peer may require a credential. `authScheme` and `authCredential` describe
one. The agent resolves it once per invocation and attaches it to both the card
fetch and the message send. When it cannot resolve one, it pauses the invocation
and raises an `adk_request_credential` call for the client to answer. The agent
reads that answer back itself on the next turn, because the shared auth
preprocessor only honours a request the LLM agent running the flow raised.

The peer may be stateful or not. A peer that returns a context id keeps its own
history, so only new events are sent. A peer that returns none needs the whole
session; ask for that with `fullHistoryWhenStateless`.

For a bounded unit of work delegated by a coordinator, use `mode: 'task'`. It
scopes the forwarded history to that task, and hands control back when the
remote calls `finish_task`.

## Get started

```ts
import {LlmAgent, RemoteA2AAgent} from '@google/adk';

const translator = new RemoteA2AAgent({
  name: 'translator',
  agentCard: 'https://translate.example.com/.well-known/agent-card.json',
});

const coordinator = new LlmAgent({
  name: 'coordinator',
  model: 'gemini-2.0-flash',
  instruction: 'Delegate translation work to the translator agent.',
  subAgents: [translator],
});
```

The card supplies the description the coordinator uses to decide when to
delegate, so you do not have to repeat it.

## Authenticating the call

```ts
import {AuthCredentialTypes, RemoteA2AAgent} from '@google/adk';

const agent = new RemoteA2AAgent({
  name: 'translator',
  agentCard: 'https://translate.example.com/.well-known/agent-card.json',
  authScheme: {type: 'apiKey', name: 'X-Api-Key', in: 'header'},
  authCredential: {
    authType: AuthCredentialTypes.API_KEY,
    apiKey: process.env.TRANSLATE_API_KEY,
  },
});
```

The credential is cached on the invocation, under a key derived from the scheme,
the credential and the remote. Two agents sharing one scheme but pointing at
different hosts get different keys, so one host's token never goes to the other.
Nothing is written to the session, so a credential does not end up in stored
history.

Supported credential shapes are OAuth2 access tokens, HTTP bearer and basic
credentials, and API keys named by a header-located `apiKey` scheme. A
credential that produces no header — an OAuth2 client id and secret that have
not been exchanged, say — counts as unresolved, and the agent asks the client
for one rather than sending the request unauthenticated.

## Delegating a task

```ts
import {RemoteA2AAgent} from '@google/adk';
import {Type} from '@google/genai';

const researcher = new RemoteA2AAgent({
  name: 'researcher',
  agentCard: 'https://research.example.com/.well-known/agent-card.json',
  mode: 'task',
  outputSchema: {
    type: Type.OBJECT,
    properties: {summary: {type: Type.STRING}},
    required: ['summary'],
  },
});
```

In task mode the agent forwards only the events in the current task's isolation
scope, plus the coordinator's call that started it. The remote signals
completion by responding to its own `finish_task` call; those call arguments
become the event's `output`, unwrapped through `outputSchema` when the schema is
not an object. The agent then emits an end-of-agent event so the coordinator
regains control.

A task that fails or is cancelled produces an error event carrying `a2a:error`
and `a2a:task_id`, a `finish_task` response reporting failure, and the same
end-of-agent event. So does an initialisation failure, an authentication
failure, and a send failure. The one exception is a pause for a credential: the
task keeps control, because the invocation resumes once the client answers.

## Intercepting requests

`requestInterceptors` and `cardRequestInterceptors` hook the message send and
the card fetch. A `beforeRequest` hook may replace the request or add headers; a
send hook that returns an `Event` instead of a request aborts the send and that
event is yielded to the caller. `afterRequest` hooks run in reverse order, and
returning `undefined` drops the event.

```ts
import {A2ARequestInterceptor} from '@google/adk';

const tracing: A2ARequestInterceptor = {
  async beforeRequest(ctx, request, params) {
    return {
      request,
      params: {
        ...params,
        headers: {...params.headers, 'X-Trace': ctx.invocationId},
      },
    };
  },
};
```

When card request interceptors are configured for a URL source, the card and the
client are rebuilt per invocation and kept local, so one session's authenticated
card cannot leak into another.

Set `useLegacy: false` to declare the ADK A2A extension on every send, which
asks an ADK server to use its newer integration.

## Other options

| Option                     | Default                      | What it does                                                 |
| -------------------------- | ---------------------------- | ------------------------------------------------------------ |
| `timeout`                  | `600000`                     | Milliseconds before the card fetch and the send abort.       |
| `fullHistoryWhenStateless` | `false`, `true` in task mode | Send the whole session to a peer that returns no context id. |
| `genaiPartConverter`       | `toA2APart`                  | Converts an outgoing part. Return `undefined` to drop it.    |
| `a2aPartConverter`         | `toGenAIPart`                | Converts an incoming part. Return `undefined` to drop it.    |
| `client` / `clientFactory` | —                            | Supply or build the A2A client yourself.                     |

## Failure modes

Card resolution and validation raise `AgentCardResolutionError`; use
`isAgentCardResolutionError` to recognise it. The agent catches it and yields an
error event rather than throwing, so a failed peer does not abort the run.

A card rejected by validation is not cached. The next run resolves it again, so
a misconfigured peer that is later fixed starts working without a restart.

Live mode is not supported.
