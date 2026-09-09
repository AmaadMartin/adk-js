# CredentialManager

`CredentialManager` owns the whole lifecycle of one tool credential: validate
the config, load a stored credential, exchange it, refresh it when it expires,
and save the result. Reach for it when a tool needs a credential and you do not
want to re-implement that sequence.

## Introduction

A tool that calls a third-party API on the user's behalf needs more than a
secret. It needs to know where the secret comes from this time. It may already
be in the credential service from a previous turn. It may have just arrived
from a consent redirect and still be an authorization code. It may be a service
account key that has to become a bearer token. It may be an access token that
expired ten minutes ago.

Each of those is a separate component in adk-js: `BaseCredentialService`,
`Context.getAuthResponse`, a `BaseCredentialExchanger`, a
`BaseCredentialRefresher`. `CredentialManager` is the one place that runs them
in the right order and decides which of them applies.

It answers with one of two things. A credential means the tool can call the
API. `undefined` means the end user still has to authorize, so the tool should
call `requestCredential` and return a placeholder. `undefined` is a control
signal, not an error.

The manager never hands back the object stored in `authConfig`. A tool config
is long-lived and shared across users, and the exchange and refresh steps
modify credentials in place, so every returned credential is a deep copy. For
the same reason the credential it persists is a copy too, and
`authConfig.exchangedAuthCredential` is left alone.

## Get started

This tool asks for a credential, and asks the user to authorize when there is
none yet.

```ts
import {
  AuthConfig,
  AuthCredentialTypes,
  Context,
  CredentialManager,
} from '@google/adk';

const authConfig: AuthConfig = {
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
  rawAuthCredential: {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {
      clientId: process.env.DOCUMENTS_CLIENT_ID,
      clientSecret: process.env.DOCUMENTS_CLIENT_SECRET,
      redirectUri: 'http://localhost:8080/callback',
    },
  },
  credentialKey: 'documents_api',
};

async function listDocuments(context: Context): Promise<string> {
  const manager = new CredentialManager(authConfig);
  const credential = await manager.getAuthCredential(context);

  if (!credential) {
    await manager.requestCredential(context);
    return 'Pending user authorization.';
  }

  // Call the provider with credential.oauth2!.accessToken here.
  return 'reports/report.pdf';
}
```

Pass a `credentialService` to the `Runner` so the exchanged token survives the
turn. Without one the credential lives only in `temp:` session state, and the
next turn asks the user again.

## The workflow

`getAuthCredential` runs these steps in order and stops at the first one that
produces a credential.

1.  **Custom scheme.** When `authScheme.type` is not one of `apiKey`, `http`,
    `oauth2` or `openIdConnect`, the registered provider answers and the
    remaining steps are skipped. See below.
2.  **Validate.** The config must be able to produce a credential. See the
    errors below.
3.  **Ready as-is.** An `apiKey` or `http` raw credential is returned
    immediately, as a copy.
4.  **Credential service.** Load the credential saved on an earlier turn. A
    service account credential skips this step.
5.  **Auth response.** Read the credential the client posted back after
    consent, from `temp:<credentialKey>` in session state.
6.  **Client credentials.** With nothing stored and a client-credentials
    scheme, fall back to a copy of the raw credential. Otherwise return
    `undefined`, because only the end user can supply the credential.
7.  **Exchange.** Turn the credential into a usable one, for example a service
    account key into a bearer token.
8.  **Refresh.** Only when step 7 did not exchange. An expired OAuth2 token is
    refreshed here.
9.  **Save.** Persist the credential when it came from the auth response, or
    was exchanged, or was refreshed. A service account credential skips this
    step too.

The manager registers defaults for the common types: `OAuth2CredentialExchanger`
for `oauth2` and `openIdConnect`, `ServiceAccountCredentialExchanger` for
`serviceAccount`, and `OAuth2CredentialRefresher` for `oauth2` and
`openIdConnect`. Call `registerCredentialExchanger` to override one on a single
manager.

## OAuth2 auto-discovery

An OAuth2 scheme that declares a flow but leaves its `authorizationUrl` or
`tokenUrl` empty is completed from the issuer's published metadata (RFC8414).
Set `issuerUrl` on the scheme for this to work. Only empty endpoints are
filled; anything you set is kept. When the scheme carries no `issuerUrl`, or
discovery finds no metadata, validation throws.

## Custom auth schemes

A scheme whose `type` is outside the four OpenAPI types is served by a provider
you register. Registration is global and the first provider for a scheme type
wins; a later, different provider is ignored with a warning.

```ts
CredentialManager.registerAuthProvider('my_scheme', new MyAuthProvider());
```

The provider receives the whole `AuthConfig` and the `Context`, and returns the
credential. When it returns an OAuth2 credential that has an `authUri` but no
`accessToken`, the manager reads that as pending consent: it records the
credential on `authConfig.exchangedAuthCredential` and returns `undefined`.

## Errors

`getAuthCredential` throws when the config cannot produce a credential:

- No raw credential on an `oauth2` or `openIdConnect` scheme.
- An `oauth2` or `openIdConnect` raw credential with no `oauth2` block.
- An OAuth2 scheme missing an endpoint that auto-discovery could not fill.
- A custom scheme with no registered provider, or a provider that returns
  nothing.

Errors raised by an exchanger or a refresher propagate unchanged.

## Limitations

- **Experimental.** The class warns once on first use and its API may change.
- **Global provider registry.** `registerAuthProvider` is static, so a scheme
  type can have only one provider per process.
- **No consumer wiring yet.** No adk-js tool calls `CredentialManager` on your
  behalf; call it from your tool as the example does.
