# MCPTool authentication and confirmation

`MCPTool` calls a tool on a Model Context Protocol (MCP) server. Its options
authenticate that call, ask a human to approve it, add per-call headers, and
report progress. Reach for them when the server is not anonymous, when the tool
changes something on the far side, or when one process talks to several tenants.

## Introduction

An MCP server is a remote process. The tools it advertises run outside your
agent, under the server's own permissions, so two questions arise that a local
`FunctionTool` never raises: who is calling, and may this call happen at all.

`McpToolOptions` answers both. `authScheme` and `authCredential` name the
credential and let ADK resolve it, the same pair `RestApiTool` takes; the
resolved credential becomes a request header on the session that carries the
call. `requireConfirmation` gates the call on a human, through the same
`BaseTool` gate `FunctionTool` uses.

An `MCPToolset` builds its tools itself and does not forward these options yet,
so configure an `MCPTool` directly when you need them.

## Get started

```ts
import {AuthCredentialTypes, MCPSessionManager, MCPTool} from '@google/adk';

const sessionManager = new MCPSessionManager({
  type: 'StreamableHTTPConnectionParams',
  url: 'https://mcp.example.com/mcp',
});

const tool = new MCPTool(
  {
    name: 'search',
    description: 'Search the corpus',
    inputSchema: {type: 'object'},
  },
  sessionManager,
  undefined,
  {
    authScheme: {type: 'http', scheme: 'bearer'},
    authCredential: {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: process.env['MCP_TOKEN']}},
    },
  },
);
```

The call now carries `Authorization: Bearer <token>`.

## Authentication

ADK resolves the credential before it opens the session, then turns it into
headers:

| Credential                                            | Header                            |
| ----------------------------------------------------- | --------------------------------- |
| `oauth2.accessToken`                                  | `Authorization: Bearer <token>`   |
| `http` with scheme `bearer` and a token               | `Authorization: Bearer <token>`   |
| `http` with scheme `basic`, a username and a password | `Authorization: Basic <base64>`   |
| `http` with any other scheme and a token              | `Authorization: <scheme> <token>` |
| `http.additionalHeaders`                              | merged on top of the header above |
| `apiKey` with an `apiKey` scheme in the header        | `<scheme name>: <key>`            |
| `serviceAccount`                                      | none, and ADK logs a warning      |

When the credential needs the user to authorize it first, `runAsync` returns
`{pending: true, message: 'Needs your authorization to access your data.'}` and
opens no session. The runner surfaces that as a credential request, and the next
turn resumes the call.

## The remaining options

```ts
const tool = new MCPTool(mcpToolDefinition, sessionManager, undefined, {
  requireConfirmation: (args) => args['force'] === true,
  headerProvider: async (context) => ({
    'X-Tenant-ID': await tenantFor(context),
  }),
  progressCallback: ({progress, total, message}) =>
    report(progress, total, message),
});
```

A gated call returns
`{error: 'This tool call requires confirmation, please approve or reject.'}` on
the first pass and opens no session; once the user answers, an approval runs the
call and a rejection returns `{error: 'This tool call is rejected.'}`.

`headerProvider` may be synchronous or asynchronous and runs once per call. Its
headers are applied on top of the authentication headers, so it wins a name
collision. With no credential and no provider, ADK sends no headers and the
transport keeps the ones it was configured with.

Use `progressCallbackFactory` in place of `progressCallback` when the callback
needs the runtime context: ADK calls the factory once per invocation with the
tool name and `{callbackContext}`. A factory that returns nothing disables
progress for that call, and configuring both is refused at construction.

## Failure modes

- A tool name that collides with a framework call — `adk_request_credential`,
  `adk_request_confirmation`, `adk_request_input` or `transfer_to_agent` — is
  refused at construction, because the server's tool would be dispatched in
  place of ADK's own.
- Each call opens one session and closes it again, on the error path too. A
  failed call is never retried, so the server never sees it twice.
- An API key configured for the query string or a cookie is refused, and so is
  an API key with no scheme at all. Neither error names the key value.
