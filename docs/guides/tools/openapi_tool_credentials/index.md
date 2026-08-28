# OpenAPI tool credentials

An `OpenAPIToolset` attaches one auth scheme and one credential to every tool
it builds from a spec. Reach for this page when a spec is secured and you need
to know where the credential comes from, and where ADK keeps it.

## Introduction

A tool generated from an OpenAPI spec calls a real API, so it needs a
credential. That credential arrives from one of three places, and the tool
tries them in this order:

1. The session, when an earlier call already obtained one.
2. The end user, through the consent handshake ADK runs for OAuth2 and OpenID
   Connect.
3. The toolset itself, when you configured `authCredential` up front.

`ToolAuthHandler` runs that order on every tool call. It hands whatever it
finds to `AutoAuthCredentialExchanger`, which mints a token for a service
account or an OAuth2 client and passes an API key straight through, and it
caches the result in session state so the next call does not pay for the
exchange again.

Two state slots are involved, and they are separate. The request slot holds
what the client answers with, under `temp:<credentialKey>`. The cache slot
holds the credential the tool uses, and it outlives the run. Both keys name
the scheme and the credential the tool declared, so two tools in one agent
never read each other's credential.

## Get started

This toolset is secured by an API key you already hold, so no consent
handshake runs. The key reaches the API in the `X-API-Key` header.

```typescript
import {AuthCredentialTypes, LlmAgent, OpenAPIToolset} from '@google/adk';

const toolset = new OpenAPIToolset({
  specStr: JSON.stringify({
    openapi: '3.0.0',
    info: {title: 'Reports', version: '1.0.0'},
    servers: [{url: 'https://reports.example.com'}],
    paths: {
      '/reports': {
        get: {
          operationId: 'listReports',
          responses: {'200': {description: 'The reports.'}},
        },
      },
    },
  }),
  authScheme: {type: 'apiKey', name: 'X-API-Key', in: 'header'},
  authCredential: {
    authType: AuthCredentialTypes.API_KEY,
    apiKey: process.env.REPORTS_API_KEY,
  },
});

const agent = new LlmAgent({
  name: 'reports_agent',
  model: 'gemini-2.0-flash',
  instruction: 'Use listReports to answer questions about reports.',
  tools: [toolset],
});
```

## Where the credential is kept

ADK derives both state keys from the scheme and the credential the tool
declared. The derivation ignores the parts of an OAuth2 credential that a
consent round trip produces, such as `authUri`, `state`, `authCode` and
`redirectUri`, so moving an agent behind a new callback URL does not orphan
the credential it already holds.

Pass `credentialKey` to name the slots yourself:

```typescript
const toolset = new OpenAPIToolset({
  specStr: spec,
  authScheme,
  authCredential,
  credentialKey: 'reports_api',
});
```

Two toolsets that share a key share a credential. That is the way to let
several specs behind one identity provider reuse a single consent. Two
toolsets that leave it unset get their own slots, even when they declare the
same kind of scheme.

The cache slot is a plain session state key, not a `temp:` one, so the
credential survives the run that obtained it. Nothing is cached for a
credential you configured that needed no exchange: it is already available on
every call, and writing it to the session would only copy the secret.

## Refreshing an OAuth2 credential

When the cached credential is an OAuth2 one whose access token has expired,
`ToolAuthHandler` refreshes it before the tool runs, then writes the refreshed
credential back to the same slot. The write-back is what keeps a provider that
rotates the refresh token working: the next call reads the rotated pair rather
than a refresh token the provider has already invalidated.

A refresh that cannot proceed is not an error. `OAuth2CredentialRefresher`
returns the credential unchanged when there is no refresh token, no token
endpoint on the scheme, or no client id and secret, and the tool call
continues with what it has.
