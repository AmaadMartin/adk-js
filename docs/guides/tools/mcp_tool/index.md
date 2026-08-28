# MCP tools

`MCPToolset` lists the tools an MCP server offers and calls them. This page
covers the options a real server needs beyond that: a credential, a human
approval step, per-invocation headers, progress, and what happens when a call
fails. Per-option detail lives in the TSDoc on `McpToolOptions`.

## Introduction

An MCP server is a remote service. It authenticates, it may act on the world,
and a call to it can fail in ways the model never sees. The options below are
the difference between a demo against a local stdio process and a tool pointed
at a server someone else runs.

They travel as one trailing `McpToolOptions` object on both `MCPTool` and
`MCPToolset`, and the toolset forwards them to every tool it builds. That
matters because the toolset is the normal entry point: a tool you never
construct yourself still has to be able to authenticate. Everything is optional
and inert by default.

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

The first gated call returns
`{error: 'This tool call requires confirmation, please approve or reject.'}` and
raises an `adk_request_confirmation` interrupt. A rejected call returns
`{error: 'This tool call is rejected.'}` and never reaches the server.

## Authentication

The credential is resolved through the same `ToolAuthHandler` the OpenAPI tools
use, then converted into request headers: OAuth2 and HTTP bearer become
`Authorization: Bearer <token>`, HTTP basic becomes a base64 pair, any other
HTTP scheme becomes `<scheme> <token>`, and an API key goes in the header its
scheme names.

Two cases are refused rather than guessed. An API key needs an `apiKey` scheme
to name its header, and that scheme must read `in: 'header'` — MCP has no query
string or cookie jar to carry a key in. A service account credential must be
exchanged for an access token before the session opens; it contributes no
headers and logs a warning.

When the client has to supply the credential, the call returns the string
`Pending User Authorization.`, opens no session, and the framework raises an
`adk_request_credential` interrupt.

## Handling failures

A failed call throws, which ends the agent turn: the model never learns the
tool failed, so it cannot retry or answer another way. Enable the
`MCP_GRACEFUL_ERROR_HANDLING` feature and the call returns a result instead:

```ts
import {FeatureName, overrideFeatureEnabled} from '@google/adk';

overrideFeatureEnabled(FeatureName.MCP_GRACEFUL_ERROR_HANDLING, true);
```

`ADK_ENABLE_MCP_GRACEFUL_ERROR_HANDLING=1` does the same. An MCP protocol error
becomes `{error: 'MCP tool execution failed: ...'}` and anything else becomes
`{error: 'Unexpected error during MCP tool execution: ...'}`, reporting the root
cause. The feature is off by default, because turning a throw into a value
changes behaviour for any caller that catches MCP failures today.

A result the server marked `isError: true` is untouched: the tool ran and
answered, so the answer reaches the model as it arrived.

## Reserved names

An MCP server may not advertise a tool named `adk_request_credential`,
`adk_request_confirmation`, `adk_request_input`, or `transfer_to_agent` — such a
tool would be dispatched in place of the framework's own call. `MCPToolset`
skips it with a warning so one bad name cannot fail the whole listing, and
constructing an `MCPTool` with one throws. Only exact matches are refused;
`transfer_to_agent_v2` is fine.

## MCP-App metadata

For a server that declares a user interface, `tool.visibility` and
`tool.mcpAppResourceUri` read the `_meta.ui` block, and `tool.rawMcpTool`
returns the declaration as the server sent it. ADK reads this metadata but does
not render it, so the accessors are for your own code.
