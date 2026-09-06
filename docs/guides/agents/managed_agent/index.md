# ManagedAgent

`ManagedAgent` drives a server-hosted managed agent from an ADK agent tree. The
backend owns the sandbox, the server-side tools and the conversation history, so
your process runs no tool code and stores no transcript. Reach for it when you
want a first-party agent with built-in server-side capabilities — Google Search,
code execution, URL context, remote MCP — instead of building and running that
environment yourself.

## Introduction

An `LlmAgent` sends a request to a model and executes any tool the model asks
for. A managed agent is different: you name an agent, not a model, and the
Managed Agents API runs the whole turn. It plans, calls its own server-side
tools inside its own sandbox, and streams the result back.

`ManagedAgent` is the ADK side of that. It is a `BaseAgent` that calls
`interactions.create` straight from its run loop, so it does not go through an
LLM flow at all. It resolves your `tools` into interaction tool params before
the call and rejects anything the client would have to execute, because there is
no client-side execution step to run it in.

Almost no state stays local. The agent keeps two ids on the events it emits, the
interaction id and the sandbox environment id, and recovers both from session
history on the next turn. The backend holds everything else, so a chained turn
sends only the new user message.

Use `ManagedAgent` where you would use an `LlmAgent` — on its own, as a sub-agent
an `LlmAgent` transfers to, as a workflow node, or wrapped in an `AgentTool` so a
coordinator can delegate to it.

## Prerequisites

You need an agent id and credentials for one of two backends.

- **Gemini Developer API.** Set `GEMINI_API_KEY`. Use an out-of-the-box agent id
  such as `antigravity-preview-05-2026`, or create your own agent.
- **Enterprise backend.** Set `GOOGLE_GENAI_USE_ENTERPRISE=1` and authenticate
  with Application Default Credentials. `ManagedAgent` pins this backend to the
  `global` location, because the Managed Agents API is served only from there.

## Get started

```ts
import {GoogleSearchTool, ManagedAgent} from '@google/adk';

const searchAgent = new ManagedAgent({
  name: 'managed_search_agent',
  description: 'Answers questions that need fresh, grounded information.',
  agentId: process.env['MANAGED_AGENT_ID'] ?? 'antigravity-preview-05-2026',
  environment: {type: 'remote'},
  tools: [new GoogleSearchTool()],
});
```

A raw `Tool` config works too, which is how you reach a server-side capability
that has no ADK tool class:

```ts
import {ManagedAgent} from '@google/adk';

const codeAgent = new ManagedAgent({
  name: 'managed_code_execution_agent',
  description: 'Answers computational questions by running code server-side.',
  agentId: 'antigravity-preview-05-2026',
  environment: {type: 'remote'},
  tools: [{codeExecution: {}}],
});
```

## Tools

`tools` accepts three shapes, and every one of them runs on the backend.

- An **ADK built-in tool** such as `GoogleSearchTool` or `UrlContextTool`. The
  request carries no model, so these tools resolve in managed-agent mode.
- A **raw `Tool` config** carrying `googleSearch`, `codeExecution`, `urlContext`
  or `computerUse`. Any other raw config is rejected.
- A **`RemoteMcpServer`** spec. The backend opens the MCP session and calls the
  tools; ADK never connects to the server.

Anything else is rejected before the network call. A `FunctionTool`, or any tool
that declares a callable function, throws during tool resolution rather than
failing mid-turn.

### Remote MCP

`headerProvider` runs once per turn, so a short-lived token is minted fresh for
each request. Its output wins over `headers` on a key conflict, and neither the
spec nor its `headers` object is mutated.

```ts
import {ManagedAgent, RemoteMcpServer} from '@google/adk';

declare function mintToken(): Promise<string>;

const server: RemoteMcpServer = {
  url: 'https://api.example.com/mcp',
  name: 'example',
  allowedTools: ['search'],
  headerProvider: async () => ({Authorization: `Bearer ${await mintToken()}`}),
};

const mcpAgent = new ManagedAgent({
  name: 'managed_mcp_agent',
  agentId: 'antigravity-preview-05-2026',
  environment: {type: 'remote'},
  tools: [server],
});
```

If `headerProvider` throws, the error propagates: a turn that could not
authenticate must not reach the backend.

## System instruction

`instruction` mirrors `LlmAgent.instruction` and is sent as the interaction's
`system_instruction` on every turn, including chained ones. A plain string may
embed `{state_var}`, `{artifact.name}` or `{var?}` placeholders, which are
resolved from session state and artifacts at request time. An
`InstructionProvider` callable manages its own state, so its output is sent
verbatim. The default is empty, which sends no system instruction.

```ts
const personaAgent = new ManagedAgent({
  name: 'managed_persona_agent',
  agentId: 'antigravity-preview-05-2026',
  environment: {type: 'remote'},
  instruction: 'You are a terse assistant. Answer in a single sentence.',
});
```

## Streaming and events

Every interaction is created with `background: true` and `stream: true`, which
the Managed Agents workflow requires. What reaches the caller depends on the run
config: in `StreamingMode.SSE` every partial response becomes an event, and
otherwise only the non-partial ones do — the aggregated final response plus any
error.

A failed call or stream does not throw. The agent yields one terminal event with
`turnComplete: true`, carrying the backend's canonical status in `errorCode`
(for example `RESOURCE_EXHAUSTED`) and its message in `errorMessage`. A failure
with no backend status uses `UNKNOWN_ERROR`. A configuration error is different:
tool resolution runs before the call, so an unsupported tool throws.

## Limitations

- **Server-side tools only.** A client-executed tool, and a raw `Tool` carrying
  `mcpServers`, are rejected during tool resolution.
- **Streaming only.** Background-polling execution is not supported.
- **The enterprise backend is pinned to `global`.** An injected enterprise
  client configured for another location is rejected at construction. A
  non-enterprise client is accepted whatever its location, because the Developer
  API has no location concept.
- **No live runs.** `runLive` throws; the live API serves no Managed Agents
  surface.
- **No usage or grounding metadata on the streamed final event.** The streaming
  conversion layer in `core/src/models/interactions_utils.ts` populates neither,
  so a run reports no token counts and no search citations.
