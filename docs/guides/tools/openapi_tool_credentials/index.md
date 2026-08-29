# OpenAPI tool credentials

An OpenAPI tool authenticates its HTTP call with a credential ADK resolves for
it. Reach for this guide when a tool needs an API key, a bearer token, or an
OAuth2 token the end user has to grant.

## Introduction

`OpenAPIToolset` and `RestApiTool` take an `authScheme`, which says how the API
authenticates, and an `authCredential`, which is the secret. Some credentials
are ready to use: an API key or an HTTP bearer token authenticates the call as
it is. Others are not. An OAuth2 authorization-code credential is only a client
id and a client secret until the end user consents, and that consent happens
outside the agent.

`ToolAuthHandler` resolves the difference on every tool call. It answers `done`
with a credential the tool can send, or `pending`, which ends the invocation
and asks the client to collect one. On each call it works through four steps,
and stops at the first that produces a usable credential:

1. The credential the session already holds for this tool. An expired OAuth2
   token is refreshed here.
2. The answer the client gave to an earlier authorization request.
3. The credential the tool was configured with.
4. A new authorization request, which returns `pending`.

A usable credential is then run through `AutoAuthCredentialExchanger`, which
mints a token for a service account or an OAuth2 client-credentials grant and
returns everything else unchanged.

## Get started

This toolset calls an API that wants an OAuth2 token from the end user. The
tool returns `{pending: true}` on the first call, and your client runs the
consent flow and starts a new run with the answer.

```ts
import {AuthCredentialTypes, OpenAPIToolset} from '@google/adk';

const toolset = new OpenAPIToolset({
  specStr: JSON.stringify(spec),
  specType: 'json',
  authScheme: {
    type: 'oauth2',
    flows: {
      authorizationCode: {
        authorizationUrl: 'https://provider.example.com/authorize',
        tokenUrl: 'https://provider.example.com/token',
        scopes: {'documents.read': 'Read your documents'},
      },
    },
  },
  authCredential: {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {
      clientId: process.env.PROVIDER_CLIENT_ID,
      clientSecret: process.env.PROVIDER_CLIENT_SECRET,
      redirectUri: 'http://localhost:8080/callback',
    },
  },
  credentialKey: 'documents_api',
});
```

An API key needs no consent, so the tool never returns `pending`:

```ts
const toolset = new OpenAPIToolset({
  specStr: JSON.stringify(spec),
  specType: 'json',
  authScheme: {type: 'apiKey', name: 'X-API-Key', in: 'header'},
  authCredential: {
    authType: AuthCredentialTypes.API_KEY,
    apiKey: process.env.DOCUMENTS_API_KEY,
  },
});
```

## Where the credential is kept

ADK writes the credential into session state, under two slots per tool. One
holds the credential for later calls, and is ordinary session state that
survives the run. The other holds the answer to an authorization request, and
is `temp:` state that the run clears when it ends.

Set `credentialKey` and both slots take that name: `documents_api` and
`temp:documents_api`. Leave it unset and ADK derives them from a SHA-256 digest
of the scheme and of the credential, reading as
`oauth2_1a2b…_oauth2_3c4d…_existing_exchanged_credential` and
`temp:adk_oauth2_1a2b…_oauth2_3c4d…`. The derived name is stable across runs
and across processes, and it gives two tools their own slot even when they
declare the same scheme type. It ignores the fields a consent round trip
produces — `authUri`, `state`, `authResponseUri`, `authCode`, `codeVerifier`,
`nonce`, `expiresAt`, `expiresIn` and `redirectUri` — so moving an agent from
`localhost` to a deployed callback URL does not lose its token.

Name the key yourself when several tools should share one credential, or when
you want a slot you can read. A `credential_key` or `credentialKey` property on
the credential or on the scheme does the same thing; the constructor option
wins over both, and the credential wins over the scheme.

## Refreshing an OAuth2 token

Before the tool sees a cached OAuth2 credential, `OAuth2CredentialRefresher`
checks `oauth2.expiresAt`. When the token has expired it posts a
`refresh_token` grant to the scheme's token endpoint and writes the answer back
to the same slot. The write-back matters for providers that rotate the refresh
token on every refresh: without it the tool keeps presenting one the provider
has already invalidated.

The refresher needs a refresh token, a token endpoint on the scheme, and the
client id and secret. When any of them is missing it logs and hands back the
credential it was given, so the tool still runs with the token it has.

## Failure modes

`prepareAuthCredentials()` throws when a tool asks the end user to authorize an
OAuth2 or OpenID Connect credential the client cannot act on. The client builds
the authorization URL from the client id and secret, so a request raised
without them can never be answered:

| Condition                                 | Error                        |
| ----------------------------------------- | ---------------------------- |
| No credential, or no `oauth2` block on it | `Error`                      |
| No `oauth2.clientId`                      | `AuthCredentialMissingError` |
| No `oauth2.clientSecret`                  | `AuthCredentialMissingError` |

The check applies to `oauth2` and `openIdConnect` schemes only. An `apiKey`,
`http` or service-account tool with no credential raises a plain request and
returns `pending`.

A client-credentials flow is exempt from the consent round trip.
`OAuth2CredentialExchanger` mints that token from the client id and secret, so
the tool goes straight to `done`.
