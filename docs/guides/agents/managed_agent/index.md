# ManagedAgent

`ManagedAgent` runs a managed agent — one hosted behind the Managed Agents API
— as an ADK agent. Reach for it when you want a Google first-party agent whose
tools and sandbox already run server-side, instead of building and hosting that
environment yourself.

## Introduction

An `LlmAgent` sends a prompt to a model and runs the tools itself. A managed
agent is different: the backend owns the agent, its sandbox environment and its
tools, and ADK only opens an interaction with it. So `ManagedAgent` extends
`BaseAgent` and calls the interactions endpoint from its own execution loop.
There is no `model` and no `Llm` in the path.

That split decides what the agent accepts. Only server-side tools work: ADK
built-in tools such as `GOOGLE_SEARCH`, raw `Tool` configs that the backend
runs, and `RemoteMcpServer` specs the backend connects to. A client-executed
tool — a `FunctionTool`, or anything ADK would have to call — is rejected at
resolution time, because nothing in this process can run it.

The agent keeps almost no local state. Each event it emits carries the
interaction id and the sandbox environment id, and the next turn recovers both
from the session's events. The backend owns the conversation history, so ADK
never re-sends earlier turns.

## Get started

```ts
import {ManagedAgent, GOOGLE_SEARCH} from '@google/adk';

const researcher = new ManagedAgent({
  name: 'researcher',
  description: 'Answers questions that need fresh information from the web.',
  agentId: 'antigravity-preview-05-2026',
  environment: {type: 'remote'},
  tools: [GOOGLE_SEARCH],
});
```

Hand it to a `Runner` as you would any other agent. The backend is chosen the
way `@google/genai` chooses it: set `GOOGLE_GENAI_USE_ENTERPRISE=1` for the
enterprise backend, and leave it unset for the Gemini Developer API.

## Tools

Three kinds of entry are accepted, and everything else is rejected.

```ts
import {ManagedAgent, GOOGLE_SEARCH, RemoteMcpServer} from '@google/adk';

const agent = new ManagedAgent({
  name: 'researcher',
  agentId: 'antigravity-preview-05-2026',
  tools: [
    // An ADK built-in tool the model runs itself.
    GOOGLE_SEARCH,
    // A raw genai tool config the backend runs.
    {codeExecution: {}},
    // A Model Context Protocol server the backend connects to.
    new RemoteMcpServer({
      url: 'https://api.example.com/mcp',
      name: 'example',
      allowedTools: ['search'],
    }),
  ],
});
```

A raw `Tool` may set `googleSearch`, `codeExecution`, `urlContext` or
`computerUse`. Anything else throws, and so does a `Tool` carrying
`functionDeclarations` or `mcpServers`.

### Remote MCP servers

ADK never opens the Model Context Protocol session described by a
`RemoteMcpServer`; it forwards the endpoint and the backend connects. Use
`headerProvider` when a header must be fresh on every turn, such as a bearer
token:

```ts
new RemoteMcpServer({
  url: 'https://api.example.com/mcp',
  headers: {'X-Api-Version': '2'},
  headerProvider: async () => ({Authorization: `Bearer ${await mintToken()}`}),
});
```

Both header maps are merged for each turn, and the provider's output wins on a
key conflict. The spec's own `headers` object is never modified. An error the
provider throws propagates, so the turn fails loudly rather than calling the
server unauthenticated.

## System instruction

`instruction` accepts the same two shapes as `LlmAgent.instruction`. A plain
string may embed `{state_var}`, `{artifact.name}` and `{var?}` placeholders,
which are resolved from session state and artifacts on every turn. An
`InstructionProvider` is called with a `ReadonlyContext` and bypasses that
injection, because it manages state itself.

```ts
const agent = new ManagedAgent({
  name: 'researcher',
  agentId: 'antigravity-preview-05-2026',
  instruction: 'You are researching {topic}. Answer in one paragraph.',
});
```

The resolved text is sent as the interaction's system instruction on every
turn, chained turns included. An empty instruction, the default, sends none.

## Streaming

Every interaction is created with `background: true` and `stream: true`, which
is what the Managed Agents workflow requires. What reaches the caller depends
on `RunConfig.streamingMode`:

- `StreamingMode.NONE`, the default: only non-partial responses become events.
- `StreamingMode.SSE`: every response becomes an event, partials included.

## Failure modes

A backend failure never propagates out of the run. The agent catches it and
yields one terminal event with `turnComplete` set, so the `Runner` cannot hang:
`errorCode` is the HTTP status the backend reported, or `UNKNOWN_ERROR` when
the failure carries none.

Configuration errors behave the opposite way, and throw:

- an `agentId` that is missing or empty;
- a `mode` other than `single_turn`;
- a tool the backend cannot run;
- an injected enterprise client that is not on the `global` location. The
  Managed Agents API is served only from `global`, so the agent pins its own
  enterprise client there and rejects one aimed elsewhere. A Developer-API
  client has no location to check.

Live mode is not supported. `runLive` throws, because the agent speaks to the
interactions endpoint and not to a live model.
