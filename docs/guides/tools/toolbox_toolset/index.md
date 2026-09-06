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
receives the live tool context, so the token may come from the session state,
the user, or an ADK credential. It runs once per tool invocation, and it may be
asynchronous.

```ts
const toolbox = new ToolboxToolset('http://127.0.0.1:5000', {
  toolsetName: 'hotel-tools',
  authTokenGetters: {
    'my-google-auth': (toolContext) => String(toolContext.state.get('idToken')),
  },
});
```

A getter that takes no arguments still works. Only the services a tool declares
are bound to it, so one getter can serve some tools of a toolset and not
others. `getTools()` rejects a getter that no loaded tool declares.

`additionalHeaders` sets headers on every request to the server. A value may be
a string or a getter.

## Authenticating the client to the server

`credentials` declares how the toolset authenticates itself, as adk-python
does. Build one with `ToolboxCredentialStrategy`; it becomes one header on the
Toolbox client, which wins a name collision with `additionalHeaders`.

| Strategy                                  | What it sends                                                                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `toolboxIdentity()`                       | Nothing. The server uses its own identity.                                                                      |
| `workloadIdentity(audience)`              | `Authorization: Bearer <Google ID token>`, minted per request from the agent's application default credentials. |
| `applicationDefaultCredentials(audience)` | The same; an alias.                                                                                             |
| `userIdentity({clientId, clientSecret})`  | The end user's OAuth2 token, after ADK asks the user to consent.                                                |
| `manualToken(token, scheme?)`             | `Authorization: <scheme> <token>`. `scheme` is `Bearer` by default.                                             |
| `manualCredentials(client)`               | `Authorization: Bearer <access token>`, read per request from an auth client.                                   |
| `apiKey(key, headerName?)`                | `key` in `headerName`, `X-API-Key` by default.                                                                  |

```ts
import {ToolboxCredentialStrategy, ToolboxToolset} from '@google/adk';

const toolbox = new ToolboxToolset('https://toolbox-abc.run.app', {
  toolsetName: 'hotel-tools',
  credentials: ToolboxCredentialStrategy.workloadIdentity(
    'https://toolbox-abc.run.app',
  ),
});
```

`ToolboxCredentialStrategy.fromAdkCredentials(credential, scheme)` converts an
ADK credential the agent already holds. A credential is validated on the first
`getTools()` call, not in the constructor.

### User identity

`userIdentity` runs ADK's interactive OAuth2 flow. The first call to a tool
that needs authentication returns an error asking the user to consent, and asks
the client for the credential. Once the user has consented, the token is sent
as the client header and as the token of every auth service the tool needs. The
credential service stores it, so later invocations reuse it.

```ts
const toolbox = new ToolboxToolset('https://toolbox.example.com', {
  credentials: ToolboxCredentialStrategy.userIdentity({
    clientId: process.env.OAUTH_CLIENT_ID!,
    clientSecret: process.env.OAUTH_CLIENT_SECRET!,
  }),
});
```

The token belongs to one invocation, so two users calling the same tool at the
same time never see each other's token.

## Reaching the server through your own HTTP client

`clientOptions` is forwarded to the `@toolbox-sdk/core` client constructor. Use
it for a preconfigured HTTP client, a fixed protocol version, or the client
name and version the server records.

```ts
const toolbox = new ToolboxToolset('https://toolbox.example.com', {
  clientOptions: {session: axiosWithProxyAndRetries, clientName: 'my-agent'},
});
```

## Lifecycle

Constructing a `ToolboxToolset` performs no I/O. The client is built on the
first `getTools()` call and reused after that. The tool list itself is not
cached: every `getTools()` call re-reads it from the server, so a tool added on
the server appears without restarting the agent.

`close()` drops the cached client. It is safe to call twice, and a later
`getTools()` builds a new client.

## Differences from adk-python

adk-python inspects a getter's signature and only passes the tool context to a
getter that declares one. JavaScript ignores a surplus argument, so the tool
context is always passed and a zero-argument getter is unaffected.

Two adk-python options are absent. `telemetryAttributes` has nothing to forward
to: `@toolbox-sdk/core` does not accept them. `secureParams` is a load-time
argument of the JavaScript SDK, and this toolset does not expose it yet.
