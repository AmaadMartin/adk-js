# MCP connection parameters

Configure how `MCPToolset` connects to an MCP server: which transport it uses,
how long it waits for the handshake, and whether it terminates the server-side
session when it disconnects. Reach for these when the defaults cost you — a
remote server that is slow to answer, or a long-lived session you must not
destroy.

## Introduction

`MCPToolset` takes an `MCPConnectionParams` object and hands it to an internal
`MCPSessionManager`, which opens a session, runs the request, and closes the
session again. There are two shapes, discriminated by `type`:

- `StdioConnectionParams` runs the MCP server as a local child process and talks
  to it over standard input and output.
- `StreamableHTTPConnectionParams` talks to a remote MCP server over HTTP.

The session is short-lived. `getTools()` opens one, lists the tools, and closes
it; every `MCPTool` call does the same. Two fields control that lifecycle:

- `timeout` bounds the `initialize` handshake, in **seconds**. Leave it unset and
  the MCP SDK's own 60 second request timeout applies. Set it when you would
  rather fail fast than block a tool call on an unreachable server.
- `terminateOnClose` decides whether closing a streamable HTTP session also sends
  the MCP `DELETE` that ends the server-side session. It defaults to `true`, so
  the server can release the session immediately instead of waiting for its own
  idle sweep.

## Get started

Connect to a remote MCP server and fail fast if it does not answer within
15 seconds:

```ts
import {MCPToolset} from '@google/adk';

const toolset = new MCPToolset({
  type: 'StreamableHTTPConnectionParams',
  url: 'https://mcp.example.com/mcp',
  timeout: 15,
});

const tools = await toolset.getTools();
await toolset.close();
```

A connection that exceeds the budget rejects with
`Failed to create MCP session: ...`, with the underlying MCP error attached as
`cause`.

The same field works for a local server over stdio:

```ts
import {MCPToolset} from '@google/adk';

const toolset = new MCPToolset({
  type: 'StdioConnectionParams',
  serverParams: {command: process.execPath, args: ['./my_mcp_server.mjs']},
  timeout: 5,
});
```

`timeout: 0` is not "no limit": it is a zero-length budget, and the handshake
fails immediately. Omit the field to get the SDK default.

## Keeping the server session alive

Set `terminateOnClose: false` when the server session outlives your client — for
example a proxy that multiplexes several clients onto one session id. ADK then
closes its own client without sending the `DELETE`.

```ts
import {MCPToolset} from '@google/adk';

const toolset = new MCPToolset({
  type: 'StreamableHTTPConnectionParams',
  url: 'https://mcp.example.com/mcp',
  terminateOnClose: false,
});
```

Termination is best effort. If the server refuses the `DELETE`, ADK logs a
warning and still closes the client, so a teardown failure never replaces the
result of the call you made.

## Fields that are not applied

`StreamableHTTPConnectionParams.sseReadTimeout` is accepted but has no effect.
The MCP TypeScript SDK's `StreamableHTTPClientTransportOptions` exposes no
read-idle timeout to forward it to. The field is kept for source compatibility,
and for parity with the Python SDK, which forwards it as the httpx read timeout.

To customise the HTTP requests themselves — headers, credentials, a custom
`fetch` — use `transportOptions`, which is passed to the SDK transport
unchanged.
