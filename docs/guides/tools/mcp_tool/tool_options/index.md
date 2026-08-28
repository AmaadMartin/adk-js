# Configuring an MCP tool

`McpToolOptions` is the trailing argument of both `MCPTool` and `MCPToolset`.
It carries everything a real MCP server tends to need: a credential, a human
approval step, per-invocation headers, and progress reporting. Reach for it as
soon as the server is more than a local stdio process you trust.

## Introduction

An MCP server is a remote service. It authenticates, it may act on the world,
and it may take long enough that a user wants to see progress. `MCPToolset`
without options handles none of that: it lists the tools and calls them.

The options live in one object rather than in a growing list of positional
parameters, and `MCPToolset` forwards them verbatim to every tool it builds.
That matters because the toolset is the normal entry point — a tool you never
construct yourself still has to be able to authenticate.

Everything here is optional and inert by default, so a toolset written before
these options existed behaves exactly as it did.

## Get started

An authenticated server, with approval required before any call runs:

```ts
import {AuthCredentialTypes, LlmAgent, MCPToolset} from '@google/adk';

const toolset = new MCPToolset(
  {type: 'StreamableHTTPConnectionParams', url: 'https://mcp.example.com/mcp'},
  [],
  undefined,
  {
    authScheme: {type: 'apiKey', in: 'header', name: 'X-Api-Key'},
    authCredential: {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: process.env['MCP_API_KEY'],
    },
    requireConfirmation: true,
  },
);

const agent = new LlmAgent({
  name: 'mcp_agent',
  model: 'gemini-2.0-flash',
  tools: [toolset],
});
```

## Authentication

`authScheme` and `authCredential` are resolved through the same
`ToolAuthHandler` the OpenAPI tools use, then converted into request headers:

| Credential                                | Header                            |
| ----------------------------------------- | --------------------------------- |
| OAuth2 with an access token               | `Authorization: Bearer <token>`   |
| HTTP `bearer` with a token                | `Authorization: Bearer <token>`   |
| HTTP `basic` with a username and password | `Authorization: Basic <base64>`   |
| HTTP with any other scheme and a token    | `Authorization: <scheme> <token>` |
| API key                                   | the header the scheme names       |

An HTTP credential's `additionalHeaders` are merged in as well. A credential
that carries no usable secret contributes no header rather than an empty one.

Two cases are refused rather than guessed. An API key needs an `apiKey` scheme
to name its header, and that scheme must read `in: 'header'` — MCP has no query
string or cookie jar to carry a key in. Neither error message repeats the key.
A service account credential contributes no headers and logs a warning: it must
be exchanged for an access token before the session opens.

When the client has to supply the credential, the call returns the string
`Pending User Authorization.` and opens no session. The framework raises an
`adk_request_credential` interrupt at the same time, and the tool runs once the
client answers it.

## Requiring approval

`requireConfirmation` is a flag, or a predicate over the arguments:

```ts
{
  requireConfirmation: (args) => args['path'] !== undefined;
}
```

The first gated call returns
`{error: 'This tool call requires confirmation, please approve or reject.'}` and
records a pending confirmation. A rejected call returns
`{error: 'This tool call is rejected.'}` and never reaches the server. The
predicate may be async, and it receives the tool context as its second argument.

Unlike `FunctionTool`, `MCPTool` does not set `skipSummarization` when it asks
for approval. This matches adk-python.

## Per-invocation headers

`headerProvider` runs on every call and its headers are merged over the auth
headers, so the provider wins a collision:

```ts
{
  headerProvider: async (context) => ({
    'X-Tenant-Id': await lookupTenant(context),
  });
}
```

Use it for anything that changes per turn — a tenant, a request id, a
short-lived token. Headers only apply to HTTP transports; a stdio connection
ignores them.

## Progress notifications

Supply `progressCallback` for a fixed callback, or `progressCallbackFactory` to
build one per invocation from the tool name and the tool context:

```ts
{
  progressCallbackFactory: (toolName) => (progress) =>
    report(toolName, progress);
}
```

Supplying both throws at construction. TypeScript cannot tell two plain
functions apart at runtime, so the choice is yours to make rather than a silent
precedence rule. A factory that returns `undefined` means no progress handler
for that call.

## Trace context

When your application registers an OpenTelemetry propagator, the active trace
context is injected into the request's `_meta` block, which is the MCP
protocol's extension point for out-of-band data. Nothing is added when no
propagator is registered, so an untraced application sends the request it
always did.

## Reserved names

An MCP server may not advertise a tool named `adk_request_credential`,
`adk_request_confirmation`, `adk_request_input`, or `transfer_to_agent`. Such a
tool would be dispatched in place of the framework's own call. Constructing one
throws, and `MCPToolset` skips it with a warning so a single bad name cannot
fail the whole listing. Only exact matches are refused; `transfer_to_agent_v2`
is fine.

## Handling failures

A failed call throws by default. See
[MCP tool error handling](../error_handling/index.md) for the feature that turns
it into a result the model can read instead.
