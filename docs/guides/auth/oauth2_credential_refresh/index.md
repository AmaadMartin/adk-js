# OAuth2 credential refresh

`OAuth2CredentialRefresher` trades a refresh token for a new access token. An
OpenAPI tool secured by an `oauth2` or `openIdConnect` scheme uses it
automatically, so a long session survives the expiry of its first access token.

## Introduction

An OAuth2 access token is short-lived. The user authorizes the agent once, and
`ToolAuthHandler` caches the exchanged credential in session state under a key
derived from the security scheme. Every later call to that tool reads the same
cached credential back. Once the token expires the API answers 401, and no
amount of retrying helps, because the cache still holds the dead token.

The refresher closes that gap. `ToolAuthHandler` looks up a refresher by the
cached credential's `authType`, asks it whether a refresh is needed, and
refreshes the credential before the tool sees it. A refreshed credential is
written back to session state, so the next tool call in the session starts from
the new token. Credential types with no registered refresher — `apiKey`, `http`,
`serviceAccount` — pass through untouched.

You need this class directly only when you build your own credential plumbing.
For OpenAPI tools it is already wired.

## Get started

Refresh a credential yourself:

```ts
import {
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  OAuth2CredentialRefresher,
} from '@google/adk';

const authScheme: AuthScheme = {
  type: 'oauth2',
  flows: {
    authorizationCode: {
      authorizationUrl: 'https://provider.example.com/authorize',
      tokenUrl: 'https://provider.example.com/token',
      scopes: {'documents.read': 'Read your documents'},
    },
  },
};

const credential: AuthCredential = {
  authType: AuthCredentialTypes.OAUTH2,
  oauth2: {
    clientId: process.env.OAUTH_CLIENT_ID,
    clientSecret: process.env.OAUTH_CLIENT_SECRET,
    accessToken: 'the-expired-access-token',
    refreshToken: 'the-refresh-token',
    expiresAt: Date.now() - 1000,
  },
};

const refresher = new OAuth2CredentialRefresher();
const current = (await refresher.isRefreshNeeded(credential))
  ? await refresher.refresh(credential, authScheme)
  : credential;

const response = await fetch('https://provider.example.com/documents', {
  headers: {Authorization: `Bearer ${current.oauth2?.accessToken}`},
});
```

Register it in a `CredentialRefresherRegistry` to look it up by credential type,
the way `ToolAuthHandler` does:

```ts
import {
  AuthCredentialTypes,
  CredentialRefresherRegistry,
  OAuth2CredentialRefresher,
} from '@google/adk';

const registry = new CredentialRefresherRegistry();
const refresher = new OAuth2CredentialRefresher();
registry.register(AuthCredentialTypes.OAUTH2, refresher);
registry.register(AuthCredentialTypes.OPEN_ID_CONNECT, refresher);
```

## When a refresh happens

`isRefreshNeeded()` returns true only when the credential carries an `oauth2`
field with an `expiresAt`, and that instant has passed. `expiresAt` is
milliseconds since the epoch, and the check applies a 60 second leeway, so a
token is treated as expired one minute before its real deadline. A credential
without `expiresAt` is never refreshed.

## Failure modes

`refresh()` never throws. It logs a warning and returns the credential it was
given when any of these is missing:

- the `oauth2` field, or the auth scheme;
- `oauth2.refreshToken`;
- `oauth2.clientId` or `oauth2.clientSecret`;
- a token endpoint on the auth scheme.

A failing token request behaves the same way: the error is logged and the
original credential comes back. The stale token then draws a 401 from the API,
which restarts the interactive authorization flow — the outcome you want when
the refresh token itself has been revoked.

The token endpoint must be HTTPS and must not resolve to a loopback, private, or
cloud-metadata address. `fetchOAuth2Tokens` rejects anything else, and it does
not follow redirects, so a credential-bearing request cannot be bounced to
another host.
