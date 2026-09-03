# RemoteA2AAgent

`RemoteA2AAgent` runs a remote agent, reached over the Agent-to-Agent (A2A)
protocol, as a local ADK agent. Reach for it when the work belongs to a service
you do not host in this process: another team's agent, a partner's endpoint, or
your own agent deployed elsewhere.

## Introduction

An A2A peer is a network service, so three things matter that do not matter for
a local sub-agent: proving who you are, deciding what the peer is allowed to see
of your session, and deciding when control comes back to you.

`RemoteA2AAgent` answers all three. An `authScheme` resolves a credential once
per invocation and sends it as HTTP headers, on both the agent-card request and
every message. An agent card fetched over the network is treated as remote data:
its RPC targets are constrained and its description is fenced before a parent
agent puts it in an instruction. And `mode: 'task'` turns the agent from a
transfer target into a delegated sub-task that hands control back when it is
done.

Without `mode`, the agent behaves like any other transfer target: the parent
transfers to it, and the peer keeps the conversation. With `mode: 'task'` the
parent keeps the conversation, the peer runs one bounded task, and only the
task's own history crosses the network.

## Get started

```ts
import {LlmAgent, RemoteA2AAgent} from '@google/adk';

const researcher = new RemoteA2AAgent({
  name: 'researcher',
  description: 'Researches a topic and returns a summary.',
  agentCard: 'https://research.example.com/.well-known/agent-card.json',
});

const coordinator = new LlmAgent({
  name: 'coordinator',
  model: 'gemini-2.0-flash',
  instruction: 'Delegate research to the researcher agent.',
  subAgents: [researcher],
});
```

The card may also be a loaded `AgentCard` object or a path to a local JSON file.

## Authentication

Set `authScheme`, and optionally the credential it uses:

```ts
import {AuthCredentialTypes, RemoteA2AAgent} from '@google/adk';

const banking = new RemoteA2AAgent({
  name: 'banking',
  agentCard: 'https://bank.example.com/.well-known/agent-card.json',
  authScheme: {type: 'apiKey', in: 'header', name: 'X-API-Key'},
  authCredential: {
    authType: AuthCredentialTypes.API_KEY,
    apiKey: process.env.BANK_API_KEY,
  },
});
```

What the agent guarantees:

- The credential is resolved once per invocation and cached under a
  `temp:`-prefixed state key, which is invocation-scoped and never persisted.
- It travels only as HTTP headers. It is never written into a message part, into
  `event.customMetadata`, or into the `a2a:request` blob.
- The derived cache key digests the scheme, the credential and the remote's
  identity, so two agents sharing one scheme on different remotes never share an
  entry. Pass `credentialKey` to choose the key yourself.
- When no credential can be resolved, the agent emits an
  `adk_request_credential` event and stops, so the client can collect one. The
  run resumes once the client answers.

An API key credential is only usable when its scheme is `{type: 'apiKey', in:
'header'}`; any other placement logs a warning and sends no header.

## Task mode

`mode: 'task'` delegates one bounded sub-task to the peer:

```ts
import {LlmAgent, RemoteA2AAgent} from '@google/adk';
import {Type} from '@google/genai';

const worker = new RemoteA2AAgent({
  name: 'research_worker',
  description: 'Researches a topic.',
  agentCard: 'https://research.example.com/.well-known/agent-card.json',
  mode: 'task',
  outputSchema: {
    type: Type.OBJECT,
    properties: {summary: {type: Type.STRING}},
    required: ['summary'],
  },
});

const coordinator = new LlmAgent({
  name: 'coordinator',
  model: 'gemini-2.0-flash',
  instruction: 'Write a post. Delegate research to research_worker.',
  subAgents: [worker],
});
```

What changes:

- **History is scoped.** The agent walks the session backwards from the
  coordinator's triggering function call, keeping only events in the same
  isolation scope. Another task's events never reach the peer. A scope with no
  triggering function call is rejected, so a workflow graph node cannot be used
  as a task scope.
- **Completion is explicit.** The peer must answer with a `finish_task` function
  response. The agent then reads that call's arguments from history and puts
  them on `event.output`.
- **Control comes back.** The final event carries `actions.endOfAgent = true`.
  A failure — a transport error, a `failed` or `canceled` remote task, an
  intercepted request, or nothing to send — emits an error event, then a
  `finish_task` error response, then that final event. A pause for credentials
  is the one exception: it keeps control, because the same run resumes.

Set `outputSchema` to mirror the peer's own output schema. An object schema
means the whole argument object becomes the output; a primitive or array schema
means the `result` key is unwrapped.

## Interceptors and converters

```ts
const peer = new RemoteA2AAgent({
  name: 'peer',
  agentCard: card,
  timeoutMs: 120_000,
  useLegacy: false,
  requestInterceptors: [tracing],
  cardRequestInterceptors: [{beforeRequest: async () => ({headers: {...}})}],
  genaiPartConverter: myGenAIToA2A,
  a2aPartConverter: myA2AToGenAI,
});
```

- `requestInterceptors` run `beforeRequest` in list order and `afterRequest` in
  reverse, so each one sees the response inside the bracket its request opened.
  Returning an `Event` from `beforeRequest` aborts the call and emits that
  event; returning `undefined` from `afterRequest` drops the event.
- `cardRequestInterceptors` contribute headers to the agent-card request only.
  When any is configured against a URL card, the card is fetched per invocation
  and never cached, because an authenticated card belongs to one session.
- The part converters replace the default conversion in each direction.
  Returning `undefined` drops the part and logs it.
- `useLegacy: false` declares the new ADK integration extension on every call.
- `timeoutMs` bounds the card fetch and the send. It defaults to 600000 ms.

## Agent-card security

A card fetched over `http(s)` is data the remote controls, so every RPC URL it
offers is checked before any traffic is sent:

- it must use `https`, or `http` on a loopback host (`localhost`,
  `*.localhost`, `127.0.0.0/8`, `::1`);
- it must share the origin the card was fetched from.

Every interface the card lists is checked, not only the primary URL, because the
client negotiates the endpoint across the whole list. A card that fails is never
cached, so the next call checks it again rather than trusting a rejected card.

The description such a card supplies is capped at 1024 characters, marked
`... [truncated]` when cut, and fenced between `<<<BEGIN_QUOTED_AGENT_CONTENT>>>`
and `<<<END_QUOTED_AGENT_CONTENT>>>` before the agent adopts it. A card passed in
as an object or read from a local file is your own configuration and is adopted
verbatim.

## Releasing resources

`close()` aborts anything in flight and drops the cached client and card. It is
safe to call twice, and it leaves a `client` or `fetchImpl` you supplied alone —
the agent never owned those. Nothing calls it for you.

```ts
await runner.runAsync(...);
peer.close();
```
