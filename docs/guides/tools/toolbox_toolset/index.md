# ToolboxToolset

Loads tools from an [MCP Toolbox for Databases](https://github.com/googleapis/genai-toolbox)
server and gives them to an agent. Reach for it when the tools an agent needs
are already defined on a Toolbox server, so the queries live in the server's
configuration instead of in your agent code.

## Introduction

A Toolbox server publishes named tools, usually SQL queries against a database,
and groups them into named toolsets. `ToolboxToolset` connects to such a server,
loads the tools you ask for, and exposes each one as a `FunctionTool`. The agent
calls them like any other ADK tool.

This is the same problem `MCPToolset` solves, for a different kind of server.
Use `MCPToolset` for a general Model Context Protocol server that you connect to
over stdio or streamable HTTP. Use `ToolboxToolset` for a Toolbox server, which
adds a tool catalogue of its own: named toolsets, parameters bound at load time,
and per-tool authentication.

`ToolboxToolset` needs the optional peer dependency `@toolbox-sdk/core`. Install
it alongside `@google/adk`:

```sh
npm install @toolbox-sdk/core
```

Without it, the first `getTools()` call fails with an error naming the package
and this command. Installing `@google/adk` alone never downloads it.

## Get started

Point the toolset at a running Toolbox server and hand it to an agent.

```ts
import {LlmAgent, ToolboxToolset} from '@google/adk';

const toolbox = new ToolboxToolset('http://127.0.0.1:5000');

const agent = new LlmAgent({
  name: 'hotel_agent',
  model: 'gemini-flash-latest',
  instruction: 'Help the user find and book a hotel.',
  tools: [toolbox],
});
```

With no options, every tool the server publishes is loaded.

## Choosing which tools to load

`toolsetName` loads one named toolset. `toolNames` loads individual tools by
name. Give both and the toolset's tools come first, then the named tools in the
order you listed them. A tool reachable both ways appears twice, so name only
the tools the toolset does not already include.

```ts
const toolbox = new ToolboxToolset('http://127.0.0.1:5000', {
  toolsetName: 'hotel-tools',
  toolNames: ['cancel_booking'],
});
```

`prefix` renames every loaded tool to `${prefix}_${name}`, which keeps two
toolsets apart when they publish the same tool name. `toolFilter` narrows the
list: an array of names, matched against the prefixed name, or a predicate
`(tool, context) => boolean`. A predicate is only evaluated when `getTools()`
receives a `ReadonlyContext`; without one every tool is returned and a warning
is logged.

## Bound parameters and authentication

`boundParams` fixes a parameter at load time. The model neither sees it in the
tool's declaration nor supplies it, which is how you keep a tenant id or a user
id out of the model's reach. A value is used as is; a function is called per
invocation and may be asynchronous.

```ts
const toolbox = new ToolboxToolset('http://127.0.0.1:5000', {
  toolsetName: 'hotel-tools',
  boundParams: {tenantId: () => currentTenant()},
});
```

`authTokenGetters` maps an auth service name to a function returning that
service's token. The server decides which tools need which service. The getter
takes no arguments, so it cannot inspect the invocation.

`additionalHeaders` sets headers on every request to the server, for
authenticating the client to the server itself. A value may be a string or a
getter. This is where a credential goes; `@toolbox-sdk/core/auth` exports
`getGoogleIdToken` for a Cloud Run or IAP deployment.

```ts
const toolbox = new ToolboxToolset('https://toolbox.example.com', {
  additionalHeaders: {'X-Api-Key': async () => await fetchKey()},
});
```

The server rejects the load when a bound parameter or an auth token getter is
not used by any tool it returns. Because the toolset issues a separate load call
for `toolsetName` and for each entry of `toolNames`, a getter that only the
other call's tools need is reported as unused.

## Lifecycle

Constructing a `ToolboxToolset` performs no I/O. The client is built on the
first `getTools()` call and reused after that. The tool list itself is not
cached: every `getTools()` call re-reads it from the server, so a tool added on
the server appears without restarting the agent.

`close()` drops the cached client. It is safe to call twice, and a later
`getTools()` builds a new client.

## Differences from adk-python

adk-python's `ToolboxToolset` takes a `credentials` object built on Google's
Python auth library. The JavaScript SDK has no equivalent, so use
`additionalHeaders` for client-to-server authentication. Python's auth token
getters can also receive the tool context; the JavaScript getters take no
arguments.
