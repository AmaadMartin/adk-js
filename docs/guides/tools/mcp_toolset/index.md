# Configuring an MCPToolset

`MCPToolset` connects to a Model Context Protocol server and turns its tools
into ADK tools. Beyond the connection it takes options that decide what the
model sees and what a tool call is allowed to do: a tools-list cache, a
confirmation gate, progress notifications, answers to the server's own
requests, and access to the server's resources. This guide covers those
options and when to reach for each.

## Introduction

An MCP server is a separate process or service, so every `getTools()` call is a
round trip and every tool call is a second one. That shapes most of what this
page describes.

Three of the options exist because the server is remote and slow.
`toolListCacheTtlSeconds` skips the discovery round trip. `progressCallback`
lets a long-running tool report how far it has got. `headerProvider` mints a
fresh credential per discovery, for a server behind authentication.

Two exist because the server is not yours. `requireConfirmation` puts a human
between the model and an action you do not want taken silently. Reserved-name
skipping and the stable sort are not options at all: the toolset always drops a
tool whose name would shadow an ADK framework tool, and always returns tools in
name order so the model's context cache stays valid across turns.

The last two are about what the server can ask of you. `samplingCallback`
answers a server that wants the client to run a model on its behalf.
`elicitationCallback` answers a server that wants more input from the user.
Both are opt-in: without a callback the client advertises no capability, and
the server never asks.

## Get started

```ts
import {MCPToolset} from '@google/adk';

const toolset = new MCPToolset({
  connectionParams: {
    type: 'StreamableHTTPConnectionParams',
    url: 'https://example.com/mcp',
  },
});

const tools = await toolset.getTools();
```

Pass the toolset to an agent. It resolves its tools when the agent runs:

```ts
import {LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'docs_agent',
  model: 'gemini-2.5-flash',
  instruction: 'Answer questions using the MCP server.',
  tools: [toolset],
});
```

## Cache the tools list

Each `getTools()` call opens a session and asks the server for its tools. Set a
lifetime in seconds to reuse the answer:

```ts
const toolset = new MCPToolset({
  connectionParams,
  toolListCacheTtlSeconds: 60,
});
```

The cache holds at most 64 entries and evicts the least recently used one. It
is keyed by the headers `headerProvider` returns, so a cached list is never
served to a different identity. Only the round trip is cached: the `toolFilter`
still runs on every call. `close()` empties the cache.

Omitting the option disables caching. A value of zero or less throws, because it
reads as a mistake rather than as a way to turn caching off.

## Require confirmation before a tool call

Pass `true`, or a predicate over the call arguments:

```ts
const toolset = new MCPToolset({
  connectionParams,
  requireConfirmation: (args) => args['path'] !== undefined,
});
```

A gated call never reaches the MCP server. On the first pass the tool raises a
confirmation request and returns an error telling the model to wait. Once a
human approves, the call runs. If the human declines, the tool returns
`This tool call is rejected.` and still does not call the server.

## Receive progress notifications

A server that reports progress during a long call needs somewhere to send it:

```ts
import {getLogger, MCPToolset} from '@google/adk';

const logger = getLogger();

const toolset = new MCPToolset({
  connectionParams,
  progressCallback: ({progress, total}) => {
    logger.debug(`${progress} of ${total}`);
  },
});
```

The callback applies to every tool the toolset returns. Without one the client
sends no progress token, so the server reports nothing.

## Authenticate with a fresh credential

`headerProvider` runs before every session the toolset opens, for discovery and
for each tool call, so a short-lived token is minted when it is needed rather
than once at startup:

```ts
const toolset = new MCPToolset({
  connectionParams,
  headerProvider: async () => ({authorization: `Bearer ${await mintToken()}`}),
});
```

Headers only apply to an HTTP transport; a stdio connection ignores them. They
also key the tools-list cache, so two identities never share an entry.

## Answer the server's requests

Sampling lets the server ask the client to run a model. Elicitation lets it ask
for user input. Supplying a callback is what advertises the capability:

```ts
const toolset = new MCPToolset({
  connectionParams,
  samplingCallback: async (request) => ({
    model: 'gemini-2.5-flash',
    role: 'assistant',
    content: {type: 'text', text: 'a sampled reply'},
  }),
  elicitationCallback: async (request) => ({action: 'decline'}),
});
```

The MCP client declares its capabilities when it is built and refuses to handle
a request for a capability it did not declare, so these cannot be added to a
live session. With neither callback set, the client advertises nothing.

## Read the server's resources

A resource is a document the server owns: a README, a schema, an image. It is
not a tool, so `getTools()` never returns one. Set `useMcpResources: true` to
add `load_mcp_resource`, the tool that reads resources into the conversation:

```ts
const toolset = new MCPToolset({connectionParams, useMcpResources: true});

const tools = await toolset.getTools();
// The server's tools in name order, then 'load_mcp_resource'.
```

The model calls it with the resource names it wants. On the next turn the tool
reads them and appends their contents to the request, as text or as base64
inline data. The contents live in that one request: they are not stored in the
session, so the model must call the tool again in a later turn.

If listing or reading a resource fails, the tool logs a warning and continues
with the resources it could read. A broken resource does not fail the turn.

The tool is appended after the sort and after the `toolFilter`, so it is always
last and a filter naming only server tools cannot drop it.

## Build a toolset from configuration

`MCPToolset.fromConfig` takes plain data, which is what you have when the server
is declared in a configuration file. Exactly one connection field must be set:

```ts
const toolset = MCPToolset.fromConfig({
  streamableHttpConnectionParams: {
    type: 'StreamableHTTPConnectionParams',
    url: 'https://example.com/mcp',
  },
  toolFilter: ['search'],
  prefix: 'docs',
  toolListCacheTtlSeconds: 60,
  useMcpResources: true,
});
```

Setting none, or both, throws with a message naming both fields.

A remote transport is never gated. A stdio server is: its `command` is launched
as a local process, so `fromConfig` refuses one until the application opts in.

```bash
export ADK_ALLOW_CONFIG_STDIO_MCP_SERVERS=1
```

The variable is read on every call, so an application that loads only trusted
configurations can set `process.env` at startup instead. Constructing an
`MCPToolset` directly is never gated: your own code already decides what runs.
