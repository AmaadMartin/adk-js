# MCP tools

`MCPToolset` lists the tools an MCP server offers and calls them. This page
covers what a server on someone else's infrastructure needs beyond that: a
credential, per-invocation headers, and progress. Per-option detail lives in
the TSDoc on `McpToolOptions`.

## Introduction

An MCP server is a remote service. It authenticates, and a call to it can fail
in ways the model never sees. The options below are the difference between a
demo against a local stdio process and a tool pointed at a server someone else
runs.

They travel as one trailing `McpToolOptions` object on both `MCPTool` and
`MCPToolset`, and the toolset forwards them to every tool it builds. That
matters because the toolset is the normal entry point: a tool you never
construct yourself still has to be able to authenticate. Everything is optional
and inert by default.

## Get started

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
  },
);

const agent = new LlmAgent({
  name: 'mcp_agent',
  model: 'gemini-2.0-flash',
  tools: [toolset],
});
```

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

## Reserved names

An MCP server may not advertise a tool named `adk_request_credential`,
`adk_request_confirmation`, `adk_request_input`, or `transfer_to_agent` — such
a tool would be dispatched in place of the framework's own call. `getTools()`
throws on one, matching adk-python, which refuses at registration. Only exact
matches are refused; `transfer_to_agent_v2` is fine.
