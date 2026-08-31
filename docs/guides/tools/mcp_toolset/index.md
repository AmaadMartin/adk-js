# MCPToolset

`MCPToolset` connects an agent to a Model Context Protocol (MCP) server and
exposes that server's tools as ADK tools. Reach for it when the tools an agent
needs already live behind an MCP server: a filesystem server, an internal API
gateway, or a third-party service.

## Introduction

An MCP server publishes tools and resources over stdio or HTTP. `MCPToolset`
lists those tools, wraps each one in an `MCPTool`, and hands them to the agent.
The agent then calls them like any other tool.

A real deployment needs more than discovery. The server usually authenticates
its callers. A multi-tenant deployment reaches one server with a different
tenant header per invocation. A high-traffic agent should not pay a
`tools/list` round trip on every turn. A destructive tool should ask a human
first. `MCPToolset` takes these as a fourth constructor argument, so a
three-argument call keeps working unchanged.

Use `MCPToolset` for tools the agent calls. Use `useMcpResources` when the agent
also needs the server's _resources_ — documents, files, or other content the
model reads rather than invokes.

## Get started

```ts
import {MCPToolset} from '@google/adk';

const toolset = new MCPToolset({
  type: 'StreamableHTTPConnectionParams',
  url: 'https://mcp.example.com/mcp',
});

const tools = await toolset.getTools();
```

`getTools()` returns the server's tools sorted by name. The order is stable
across turns, so it does not invalidate the model's context cache.

Give the toolset to an agent and close it when you are done:

```ts
import {LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'file_assistant',
  model: 'gemini-2.0-flash',
  instruction: 'Help the user with their files.',
  tools: [toolset],
});
```

## Authentication

Declare the scheme the server uses, then let the host exchange the credential.
`getAuthConfig()` returns the toolset's own config instance. The host fills
`exchangedAuthCredential` on it in place, and every later call sends the
matching header.

```ts
import {AuthCredentialTypes, MCPToolset} from '@google/adk';

const toolset = new MCPToolset(
  {type: 'StreamableHTTPConnectionParams', url: 'https://mcp.example.com/mcp'},
  [],
  undefined,
  {
    authScheme: {type: 'apiKey', in: 'header', name: 'X-API-Key'},
    credentialKey: 'example-mcp',
  },
);

const authConfig = toolset.getAuthConfig();
authConfig!.exchangedAuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: process.env['EXAMPLE_MCP_API_KEY'],
};
```

`getAuthConfig()` returns the same instance every call, which is what makes the
in-place assignment work.

````

The supported credentials and the header each produces:

| Credential                                   | Header                            |
| -------------------------------------------- | --------------------------------- |
| OAuth2 with an access token                  | `Authorization: Bearer <token>`   |
| HTTP `bearer` with a token                   | `Authorization: Bearer <token>`   |
| HTTP `basic` with a username and a password  | `Authorization: Basic <base64>`   |
| Any other HTTP scheme with a token           | `Authorization: <scheme> <token>` |
| API key with a scheme whose `in` is `header` | `<scheme.name>: <key>`            |

An OAuth2 credential with no access token sends no header, rather than the
literal string `Bearer undefined`. An API key configured for a query string
sends no header and logs a warning; only header placement is supported.

## Per-request headers

`headerProvider` runs on every call and receives the invocation. Use it to route
one server by tenant, user, or region. It may be synchronous or asynchronous.

```ts
const toolset = new MCPToolset(connectionParams, [], undefined, {
  headerProvider: (context) => ({
    'X-Tenant-ID': String(context.state.get('tenant')),
  }),
});
````

Auth headers are applied after the provider's, so a provider cannot overwrite
`Authorization`. A provider that throws or rejects fails the call: a request
that cannot carry its tenant must not go out without one.

The provider needs a context to read, so it does not run when `getTools()` is
called without one.

## Caching the tool list

`toolListCacheTtlSeconds` reuses the server's `tools/list` response for that many
seconds:

```ts
const toolset = new MCPToolset(connectionParams, [], undefined, {
  toolListCacheTtlSeconds: 60,
});
```

What the cache guarantees:

- Entries are keyed by the merged headers, so one tenant never sees another's
  tool list.
- The cache holds at most 64 entries, and evicts the least recently used one.
- A cache hit still runs the tool filter, so a filter that depends on the
  context keeps working.
- The cache lives on the toolset instance. Sharing the cache means sharing the
  instance.

ADK does not subscribe to `notifications/tools/list_changed`, so a tool the
server adds or removes goes unnoticed until the entry expires. `close()` empties
the cache.

A value of `0` or less throws. Leave the option unset to list on every call.

## Human approval

`requireConfirmation` gates every tool of the toolset. Pass `true`, or a
predicate over the call arguments:

```ts
const toolset = new MCPToolset(connectionParams, [], undefined, {
  requireConfirmation: (args) => String(args['path']).startsWith('/etc'),
});
```

A gated call returns a request for approval instead of reaching the server. It
runs once the user approves, and returns a rejection if the user declines.

## Resources

Set `useMcpResources` to expose the server's resources. The toolset appends a
`load_mcp_resource` tool after the sorted tools, and the model calls it to pull
resource contents into the conversation.

```ts
const toolset = new MCPToolset(connectionParams, [], undefined, {
  useMcpResources: true,
});
```

It defaults to false. `listResources()`, `getResourceInfo()` and
`readResource()` read the same resources directly.

## Progress notifications

An MCP server can report progress while a long tool call runs. Pass one callback
for every tool, or a factory that builds one per tool:

```ts
const toolset = new MCPToolset(connectionParams, [], undefined, {
  progressCallback: (progress) => {
    // `reportProgress` is your own function.
    reportProgress(progress.progress, progress.total);
  },
});
```

A callback that throws or rejects is logged and swallowed: a progress
notification must not fail the tool call. When both options are set, the factory
wins.

## Server-to-client requests

An MCP server can call back into the client. Supply `samplingCallback` to answer
`sampling/createMessage`, and `elicitationCallback` to answer
`elicitation/create`:

`runInference` and `askTheUser` below are your own functions.

```ts
const toolset = new MCPToolset(connectionParams, [], undefined, {
  samplingCallback: async (request) => ({
    model: 'gemini-2.0-flash',
    role: 'assistant',
    content: {type: 'text', text: await runInference(request)},
  }),
  elicitationCallback: async (request) => ({
    action: 'accept',
    content: await askTheUser(request),
  }),
});
```

The matching capability is declared to the server only when its callback is
supplied, so a server never asks for something this client cannot answer.
`samplingCapabilities` adds detail to the declared `sampling` capability.
