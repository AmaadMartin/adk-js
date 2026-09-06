# RemoteMcpServer: server-side MCP

Describes a remote Model Context Protocol (MCP) server that the Managed Agents
API runs on its own side. ADK forwards the endpoint and the headers; the backend
opens the session and runs the tools. Reach for this page when the MCP server
should not be reached from your process, or when its credential must be minted
fresh on every turn.

## Introduction

ADK has two ways to use an MCP server, and they differ in who opens the session.

`MCPToolset` is the client-side way. Your process connects to the server, lists
its tools and calls them. The traffic leaves your machine, and the toolset owns
the connection, the deadline and the retry.

`RemoteMcpServer` is the server-side way. It is a description, not a client. It
carries the URL, an optional label, the headers, and the list of tools the model
may call. ADK never connects to the server: it maps the description to an
`mcp_server` tool param and sends that to the Interactions API, and the backend
opens the session. Only a remote (HTTP or streamable HTTP) MCP server works
here, because the backend must be able to reach it.

Choose the server-side form when the MCP server is a hosted endpoint the backend
can reach, and the client-side form when the server is local, or when you need
the tool traffic to pass through your process. The one thing the two share is
the header-provider contract: a callback that mints headers for one turn.

This is the TypeScript counterpart of `RemoteMcpServer` in
[adk-python](https://github.com/google/adk-python).

## Get started

Describe a server:

```ts
import type {RemoteMcpServer} from '@google/adk';

const server: RemoteMcpServer = {
  url: 'https://api.example.com/mcp',
  name: 'places',
  headers: {'X-Api-Version': '2'},
  allowedTools: ['search_places', 'place_details'],
};
```

ADK maps that to the `mcp_server` tool param it sends to the Interactions API:

```json
{
  "type": "mcp_server",
  "url": "https://api.example.com/mcp",
  "name": "places",
  "headers": {"X-Api-Version": "2"},
  "allowed_tools": [{"tools": ["search_places", "place_details"]}]
}
```

The five fields:

| Field            | Meaning                                                     |
| ---------------- | ----------------------------------------------------------- |
| `url`            | Full URL of the endpoint. Required.                         |
| `name`           | Optional label for the server.                              |
| `headers`        | Static headers sent on every turn, such as a fixed API key. |
| `allowedTools`   | Restricts which of the server's tools the model can call.   |
| `headerProvider` | Mints headers at request time, once per turn.               |

The configuration fields are camelCase because they stay inside the process. The
tool param uses `allowed_tools`, because that key crosses the API boundary and
must match what the Interactions backend accepts.

## Static headers and minted headers

A static header lives in `headers` and goes out unchanged on every turn. A
minted header comes from `headerProvider`, which ADK calls once per turn with
the context of that turn. Use it for a credential that expires, such as a bearer
token:

```ts
import type {ReadonlyContext, RemoteMcpServer} from '@google/adk';

const server: RemoteMcpServer = {
  url: 'https://api.example.com/mcp',
  headers: {'X-Api-Version': '2'},
  headerProvider: async (context: ReadonlyContext) => ({
    Authorization: `Bearer ${await mintToken(context.userId)}`,
  }),
};
```

ADK copies the static headers first, then assigns the provider output over the
copy. **The provider wins on a key conflict.** The copy means your `headers`
object never changes, so the same description is safe to reuse across turns.

An error from the provider propagates. A failed token mint is loud, not a
silently missing `Authorization` header.

The param omits `headers` when the resolved headers are empty, so a provider
that returns `{}` for a server with no static headers sends no header key at
all.

## Restricting the tools

`allowedTools` maps to `allowed_tools: [{tools: [...]}]`. It is guarded on
`undefined`, not on emptiness: an empty array is a meaningful restriction and is
forwarded as `[{tools: []}]`. Leave the field unset to expose every tool the
server advertises.
