# Authenticating an MCP toolset

`MCPToolset` and `MCPTool` accept an auth scheme and a credential. Every tool
call resolves the credential and sends it to the MCP server as a request
header.

## Introduction

An MCP server on the public internet is usually protected. Before this
existed, the only way to reach one from ADK was to write the `Authorization`
header into `transportOptions.requestInit.headers` yourself, at construction
time. That works for a token you already hold, and for nothing else: the header
is fixed for the life of the toolset, and it is the same header for every user
of the agent.

Declaring an auth scheme instead moves the decision to call time. ADK resolves
a credential for each tool call through `ToolAuthHandler`, the same component
`RestApiTool` uses for OpenAPI tools, converts it into headers, and attaches
them to that one MCP session. An OAuth2 credential is exchanged for an access
token, and the result is cached in session state so the next call reuses it.

Two pieces describe what the server wants:

- `AuthScheme` says how the server authenticates. It is the OpenAPI 3 security
  scheme type: `http`, `apiKey`, `oauth2`, or `openIdConnect`.
- `AuthCredential` is the secret. `authType` picks the shape and the matching
  field (`http`, `apiKey`, `oauth2`, `serviceAccount`) holds it.

Only the StreamableHTTP transport carries headers. A stdio server runs as a
local child process, so it receives none.

Only a tool call is authenticated. Tool discovery is not: `getTools`,
`listResources`, `getResourceInfo` and `readResource` open their session with
no credential. A server that rejects an unauthenticated `tools/list` therefore
needs a header on `transportOptions.requestInit.headers` to be discovered at
all. adk-python has the same gap.

## Get started

This toolset sends a bearer token to a remote MCP server. Every tool it
produces sends the same header.

```ts
import {AuthCredentialTypes, MCPToolset} from '@google/adk';

const toolset = new MCPToolset(
  {type: 'StreamableHTTPConnectionParams', url: 'https://mcp.example.com/mcp'},
  [],
  undefined,
  {
    authScheme: {type: 'http', scheme: 'bearer'},
    authCredential: {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: process.env.MCP_TOKEN}},
    },
  },
);

const tools = await toolset.getTools();
```

The fourth argument is the auth options. The second and third are the existing
tool filter and name prefix; pass `[]` and `undefined` to keep their defaults.

## How a credential becomes a header

| Credential                    | Header                                         |
| ----------------------------- | ---------------------------------------------- |
| `oauth2` with an access token | `Authorization: Bearer <accessToken>`          |
| `http`, scheme `bearer`       | `Authorization: Bearer <token>`                |
| `http`, scheme `basic`        | `Authorization: Basic <base64(user:password)>` |
| `http`, any other scheme      | `Authorization: <scheme> <token>`              |
| `apiKey`                      | the header the scheme's `name` declares        |
| `serviceAccount`              | none; ADK logs a warning                       |

An `http` credential may also carry `additionalHeaders`, which are merged on
top of the header above.

An API key must be sent in a header. The scheme has to be
`{type: 'apiKey', name: '<header>', in: 'header'}`; any other location throws.

```ts
const toolset = new MCPToolset(
  {type: 'StreamableHTTPConnectionParams', url: 'https://mcp.example.com/mcp'},
  [],
  undefined,
  {
    authScheme: {type: 'apiKey', name: 'X-API-Key', in: 'header'},
    authCredential: {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: process.env.MCP_API_KEY,
    },
  },
);
```

## Where the credential is cached

An exchanged credential is written to session state under
`${credentialKey}_existing_exchanged_credential`. `credentialKey` defaults to
`mcp_${authScheme.type}`, so every tool from one server shares one slot instead
of resolving a credential each.

Set it explicitly when one agent talks to two MCP servers with the same scheme
type, so their tokens do not share a slot:

```ts
const toolset = new MCPToolset(connectionParams, [], undefined, {
  authScheme: {type: 'http', scheme: 'bearer'},
  credentialKey: 'internal_mcp_server',
});
```

A statically configured credential is not cached. It is available on every
call already, so writing it into the session store would copy a secret for
nothing.

## Interaction with headers you configure yourself

Headers set on `transportOptions.requestInit.headers` are still sent. The
resolved credential is merged over them, so a header of the same name is
replaced for that call only. The connection parameters you construct the
toolset with are never modified.

## When no credential is available

`ToolAuthHandler` asks the client for one and the tool call returns
immediately:

```ts
{pending: true, message: 'Needs your authorization to access your data.'}
```

This is the same envelope an OpenAPI tool returns, so a client that already
handles that case needs no change. The invocation records the request in
`eventActions.requestedAuthConfigs`; the application collects the credential
and starts a new run.

A credential that fails to resolve throws. ADK does not fall back to an
unauthenticated call.

## OAuth2

The grant decides how far ADK can get on its own.

- **Client credentials.** A credential holding a client id and secret is
  exchanged at the scheme's `tokenUrl` on the first call. Nothing is asked of
  the end user.
- **Authorization code, and every other grant.** The user must authorize
  first. A credential holding only a client id and secret is not sent to the
  exchanger; ADK returns the pending envelope above and puts an authorization
  URL in `eventActions.requestedAuthConfigs`. Your application sends the user
  there and starts a new run with the redirect it lands on, in
  `oauth2.authResponseUri`. ADK then exchanges the code for a token and caches
  it.
- **A token you already hold.** Put it in `oauth2.accessToken` and it is sent
  as `Authorization: Bearer <token>` with no exchange.

```ts
const toolset = new MCPToolset(connectionParams, [], undefined, {
  authScheme: {
    type: 'oauth2',
    flows: {
      authorizationCode: {
        authorizationUrl: 'https://example.com/o/oauth2/auth',
        tokenUrl: 'https://example.com/token',
        scopes: {'read:tools': 'Read your tools'},
      },
    },
  },
  authCredential: {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {
      clientId: process.env.OAUTH_CLIENT_ID,
      clientSecret: process.env.OAUTH_CLIENT_SECRET,
    },
  },
});
```

## Auth on `AgentRegistrySingleMCPToolset`

`AgentRegistrySingleMCPToolset` accepts `authScheme`, `authCredential` and
`credentialKey`, and forwards all three to every tool it resolves. Its
`headerProvider` still applies, but only at discovery time.
