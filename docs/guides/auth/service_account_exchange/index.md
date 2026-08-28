# Service account credentials for OpenAPI tools

An `OpenAPIToolset` that calls a Google API, a Cloud Run service, or a Cloud
Function authenticates with a service account. ADK exchanges the account
configuration for a bearer token before each request. Reach for this when the
API belongs to your own project and no end user has to consent.

## Introduction

A service account is an identity your application owns, so no consent handshake
is needed. That makes it the right credential for an API you control, and the
wrong one for an API that acts on a person's behalf. For the second case, use
`AuthConfig` and the pause-for-consent flow instead.

Google services accept two different bearer tokens, and picking the wrong one
fails at the first request:

- An **access token** carries scopes. Google APIs such as BigQuery and Cloud
  Storage check the scope, so this is the default.
- An **ID token** carries an audience. Cloud Run, Cloud Functions, and other
  services that verify caller identity check that the audience matches their
  own URL, and reject an access token.

`ServiceAccount` selects between them. `useIdToken` picks the ID token, and
`audience` names the receiving service. Key material is optional:
`useDefaultCredential` reads Application Default Credentials from the
environment, which is what a workload on Cloud Run or GKE normally wants.

## Get started

This toolset calls a BigQuery endpoint with an access token minted from
Application Default Credentials.

```typescript
import {AuthCredentialTypes, OpenAPIToolset} from '@google/adk';

const toolset = new OpenAPIToolset({
  specStr: bigquerySpec,
  specType: 'json',
  authCredential: {
    authType: AuthCredentialTypes.SERVICE_ACCOUNT,
    serviceAccount: {
      useDefaultCredential: true,
      scopes: ['https://www.googleapis.com/auth/bigquery'],
    },
  },
});
```

Leave `scopes` out and the exchange requests
`https://www.googleapis.com/auth/cloud-platform`.

To use an explicit key instead, set `serviceAccountCredential` to the parsed
service-account JSON file. Scopes are then required, because a token minted
without them is rejected by most Google APIs.

```typescript
import {AuthCredentialTypes, OpenAPIToolset} from '@google/adk';

const toolset = new OpenAPIToolset({
  specStr: bigquerySpec,
  specType: 'json',
  authCredential: {
    authType: AuthCredentialTypes.SERVICE_ACCOUNT,
    serviceAccount: {
      serviceAccountCredential: JSON.parse(keyFileContents),
      scopes: ['https://www.googleapis.com/auth/bigquery'],
    },
  },
});
```

## The quota project header

Application Default Credentials often belong to a project that is not the one
you want billed. On the access-token path, the exchange therefore sends
`x-goog-user-project` alongside the `Authorization` header. It takes the auth
client's quota project when the environment sets one, and the project the
credentials resolve to otherwise. When neither resolves, the exchange sends no
such header and the request still goes out.

An explicit service-account key never gets the header. The key already names its
project.

## ID tokens for Cloud Run

Set `useIdToken` and `audience` to call a private Cloud Run service. The
audience is the service URL, with no path.

```typescript
import {AuthCredentialTypes, OpenAPIToolset} from '@google/adk';

const toolset = new OpenAPIToolset({
  specStr: inventorySpec,
  specType: 'json',
  authCredential: {
    authType: AuthCredentialTypes.SERVICE_ACCOUNT,
    serviceAccount: {
      useDefaultCredential: true,
      useIdToken: true,
      audience: 'https://inventory-abc123-uc.a.run.app',
    },
  },
});
```

`scopes` is ignored on this path, and no quota project header is sent.

## Token reuse

The exchange runs on every tool call. It keeps the `google-auth-library` client
it built, so the second call reuses the token the client already holds instead
of minting another. The client decides when to refresh, shortly before the token
expires.

Two configurations share a client only when they agree on every field that
changes the token: `useDefaultCredential`, `privateKeyId`, `clientEmail`,
`scopes`, and `audience`. The private key is never part of the cache key. The
cache is bounded and evicts the oldest client first, so an application that
builds configurations at runtime cannot grow it without limit.

The clients live in the module, so they are shared by every toolset in the
process.

## Errors

Every failure raises `CredentialExchangeError`. The exchange rejects a
configuration it cannot use before it calls Google: a credential with no
`serviceAccount`, an explicit exchange with no key material, an explicit
access-token exchange with no `scopes`, and `useIdToken` with no `audience`.
When Google or the auth library rejects the request instead, the error names the
path that failed and quotes the underlying cause.

A failed exchange caches no client, so fixing the configuration and calling
again mints a token.
