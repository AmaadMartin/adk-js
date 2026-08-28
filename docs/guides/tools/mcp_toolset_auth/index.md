# Authenticating an MCPToolset

`MCPToolset` reaches a Model Context Protocol server that requires a
credential. You describe the credential with an auth scheme, supply the
credential itself, and the toolset sends the matching HTTP header on tool
discovery, on every tool call and on resource reads.

## Introduction

Most MCP servers you do not run yourself are behind authentication. An API key
in a header, an OAuth2 access token, or HTTP basic auth are the common cases.

`MCPToolset` separates the two halves of that problem.

- The **auth scheme** is static configuration. It says what kind of credential
  the server wants, and for an API key it also names the header.
- The **credential** is the value that is sent. A scheme such as `apiKey` or
  `http` needs no exchange, so `authCredential` is used as it is. OAuth2 does
  need an exchange, and the access token only exists at runtime.

For the second case the toolset keeps one `AuthConfig` and reads the credential
from it every time it opens a session. `getAuthConfig()` returns that object,
and it is the same instance on every call, so whoever obtains the access token
writes it onto the config and the next `getTools()` call sends it. An exchanged
credential takes precedence over the one you configured.

Use `headerProvider` when the header is not a credential — a tenant id, a trace
id, a routing hint. The two combine: the toolset merges the auth header over
the provider's headers, matching header names case-insensitively, so the
credential always wins over a header a caller hardcoded.

Headers only apply to HTTP transports. A `StdioConnectionParams` connection
runs the server as a child process, which has no request headers, so the
credential is ignored there.

## Get started

The smallest case is an API key. The scheme names the header, and the
credential carries the value.

```ts
import {AuthCredentialTypes, MCPToolset, type AuthScheme} from '@google/adk';

const apiKeyScheme: AuthScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'X-API-Key',
};

const toolset = new MCPToolset({
  connectionParams: {
    type: 'StreamableHTTPConnectionParams',
    url: 'https://mcp.example.com/mcp',
  },
  authScheme: apiKeyScheme,
  authCredential: {
    authType: AuthCredentialTypes.API_KEY,
    apiKey: process.env['MCP_API_KEY'] ?? '',
  },
});

const tools = await toolset.getTools();
```

Every request the toolset makes now carries `X-API-Key`.

## Supplying a token that only exists at runtime

An OAuth2 access token is not known when the toolset is built. Write it onto
the auth config once you have it.

```ts
import {AuthCredentialTypes, MCPToolset, type AuthScheme} from '@google/adk';

const oauth2Scheme: AuthScheme = {
  type: 'oauth2',
  flows: {
    authorizationCode: {
      authorizationUrl: 'https://example.com/auth',
      tokenUrl: 'https://example.com/token',
      scopes: {read: 'Read access'},
    },
  },
};

const toolset = new MCPToolset({
  connectionParams: {
    type: 'StreamableHTTPConnectionParams',
    url: 'https://mcp.example.com/mcp',
  },
  authScheme: oauth2Scheme,
});

const authConfig = toolset.getAuthConfig();
if (authConfig) {
  authConfig.exchangedAuthCredential = {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {accessToken: await mintAccessToken()},
  };
}

const tools = await toolset.getTools();
```

## What each credential sends

The credential decides the header. The auth scheme is only read for an API key,
because the credential does not carry a header name.

| Credential                                            | Header sent                           |
| ----------------------------------------------------- | ------------------------------------- |
| `oauth2.accessToken`                                  | `Authorization: Bearer <accessToken>` |
| `http` with scheme `bearer` and a token               | `Authorization: Bearer <token>`       |
| `http` with scheme `basic`, a username and a password | `Authorization: Basic <base64>`       |
| `http` with any other scheme and a token              | `Authorization: <scheme> <token>`     |
| `http.additionalHeaders`                              | merged over the header above          |
| `apiKey` with an `apiKey` scheme in `header`          | `<scheme.name>: <apiKey>`             |

A credential that carries nothing usable sends no header. An OAuth2 credential
that has a client id but no access token yet is the normal case before the
exchange runs, and the toolset sends the request unauthenticated rather than
sending `Bearer undefined`. An API key whose scheme puts it in the query string
or a cookie sends nothing and logs a warning: only the header location is
supported.

## Naming the credential slot

`credentialKey` names the slot the exchanged credential is stored under. It
defaults to `default_mcp_key`. Give each toolset its own key when one agent
talks to several MCP servers, so their credentials do not share a slot.

## What the tools carry

`getTools()` resolves the headers once and hands them to every `MCPTool` it
returns. A tool called later in the turn reaches the server with the same
credential, and does not re-read the auth config. Call `getTools()` again after
the credential changes.
