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

## Opening the session, and losing it

Session setup is retried once. Only setup: once the call is on the wire, no
failure re-sends it, because the server may already have run the tool. An
invocation whose `abortSignal` is already aborted is not retried either.

Losing the transport mid-call is handled separately. The MCP SDK covers most
of it. It rethrows a failed send, and it rejects every in-flight request when
the transport closes. It does not cover a dropped event stream that it has
stopped trying to resume: nothing closes, so the call waits out the SDK's
60-second request timeout. `MCPTool` runs every call through
`MCPSessionManager.runGuarded`, which rejects with
`MCP session connection lost: <error>` at that point. Nothing to configure.

The guard fires only for that terminal case. A transport error the session
survives is logged and otherwise ignored, so a server that refuses the
optional standalone event stream keeps working. A POST-only gateway answering
GET with 404 is the common example. The session is still closed on every path,
and an error the tool itself raised still propagates unwrapped, so a tool
failure stays distinguishable from a transport failure.

## MCP-App metadata and widgets

For a server that declares a user interface, `tool.mcpAppResourceUri` reads the
`_meta.ui` block and `tool.rawMcpTool` returns the declaration as the server
sent it.

A tool declaring a `ui://` resource also attaches a widget to the event when
the call succeeds, so a host can draw the app beside the result:

```ts
const result = await tool.runAsync({args: {message: 'hello'}, toolContext});

toolContext.eventActions.renderUiWidgets;
// [{id: '<function call id>', provider: 'mcp',
//   payload: {resource_uri: 'ui://widget/echo', tool: {...}, tool_args: {...}}}]
```

The payload keys are snake_case because the MCP Apps renderer reads them.
Nothing attaches when the call fails, when the tool declares no `_meta`, when
the URI is outside the `ui://` scheme, or when the call carries no function
call id to address the widget by. ADK collects the widgets; it does not render
them.
