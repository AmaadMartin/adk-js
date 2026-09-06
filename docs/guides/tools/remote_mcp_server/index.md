# RemoteMcpServer

Describe a remote Model Context Protocol (MCP) server that the Managed Agents
API runs on the server side. Reach for it when the backend, not your process,
must open the MCP session.

## Introduction

ADK has two ways to reach an MCP server, and they differ in who opens the
session.

`McpToolset` is the client-side one. Your process connects to the server, reads
its tool list, and runs each tool locally. The tool results travel back through
your agent.

`RemoteMcpServer` is the server-side one. You describe the endpoint — its URL,
its headers, and which of its tools the model may call. ADK forwards that
description to the Interactions API, and the backend opens the session and runs
the tools. ADK never connects to the server itself. Only remote servers work
here, over HTTP or streamable HTTP; a server you launch as a local subprocess
has no URL to forward.

`RemoteMcpServer` is a specification, not a toolset. It is a plain interface:
it carries no `getTools()` and it executes nothing. adk-js does not yet have
`ManagedAgent`, the agent that forwards the specification to the backend, so
nothing in the SDK consumes a `RemoteMcpServer` today. The type and its mapping
ship first so that the specification is stable when that agent lands.

## Get started

```typescript
import {RemoteMcpServer} from '@google/adk';

const maps: RemoteMcpServer = {
  url: 'https://mcp.example.com/mcp',
  name: 'maps',
  allowedTools: ['search_places'],
};
```

Only `url` is required. Every other field is optional. TypeScript rejects a key
that is not one of the five, so a typo is a compile error rather than a setting
that silently does nothing.

## Validating a description TypeScript never saw

The compile-time check reaches an object literal you write by hand. It does not
reach a description that arrives from a configuration file, from JavaScript, or
through a variable that has been widened along the way. Pass such a description
through `createRemoteMcpServer`, which checks the same rules when it runs.

```typescript
import {createRemoteMcpServer} from '@google/adk';

const maps = createRemoteMcpServer({
  url: 'https://mcp.example.com/mcp',
  name: 'maps',
  allowedTools: ['search_places'],
});
```

It throws `InputValidationError` when a key is not one of the five, when `url`
is missing or empty, and when a field holds the wrong type. The message names
the offending key, so `{headers: {'X-Bad': 3}}` reports
`RemoteMcpServer.headers.X-Bad must be a string.`

It returns a new object, and it copies `headers` and `allowedTools`. Editing
the description you passed in cannot change the specification you got back.

## Headers

Two fields supply headers, and they serve different lifetimes.

`headers` holds values that never change, such as a fixed API key. `headerProvider`
is a callback that runs once per turn, so it can mint a value that expires —
a bearer token, for example. It receives the turn's `ReadonlyContext` and
returns a headers record, or a promise of one.

```typescript
import {ReadonlyContext, RemoteMcpServer} from '@google/adk';

declare function mintKey(userId: string): Promise<string>;

const maps: RemoteMcpServer = {
  url: 'https://mcp.example.com/mcp',
  headers: {'X-Static': 'v'},
  headerProvider: async (context: ReadonlyContext) => ({
    'X-Goog-Api-Key': await mintKey(context.userId),
  }),
};
```

`resolveRemoteMcpServerHeaders` performs that merge, once per turn. It copies
`headers`, then assigns the callback's output over the copy, so the callback
wins on a key conflict. The copy means a turn never changes the specification
you wrote: `maps.headers` holds the same values after a turn as before.

```typescript
import {resolveRemoteMcpServerHeaders} from '@google/adk';

const headers = await resolveRemoteMcpServerHeaders(maps, readonlyContext);
```

An error thrown by `headerProvider` propagates to the caller. ADK does not
catch it and does not fall back to the static headers, so a failed token mint
fails the turn instead of sending a request the server will reject.

## What crosses the wire

ADK maps the specification internally; you do not call the mapping yourself.
The specification becomes one `mcp_server` tool param:

```json
{
  "type": "mcp_server",
  "url": "https://mcp.example.com/mcp",
  "name": "maps",
  "headers": {"X-Static": "v", "X-Goog-Api-Key": "..."},
  "allowed_tools": [{"tools": ["search_places"]}]
}
```

The param keys stay in snake case, because that is what the API reads. The
interface fields stay in camel case, because that is what TypeScript reads.

A field you did not set is left out. A field you set to an empty value is sent:
`allowedTools: []` becomes `"allowed_tools": [{"tools": []}]`, which tells the
backend that no tool on that server is callable. `headers` is the one
exception — an empty header record adds no key, because there is nothing to
send.
