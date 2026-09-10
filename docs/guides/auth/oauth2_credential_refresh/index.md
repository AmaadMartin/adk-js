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

The refresher closes that gap. `ToolAuthHandler` passes the cached credential
through the refresher before the tool sees it, and writes the result back to
session state when the tokens changed, so the next tool call in the session
starts from the new token. A credential of any other type — `apiKey`, `http`,
`serviceAccount` — carries no `oauth2` field and passes through untouched.

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

const current = await new OAuth2CredentialRefresher().refresh(
  credential,
  authScheme,
);

const response = await fetch('https://provider.example.com/documents', {
  headers: {Authorization: `Bearer ${current.oauth2?.accessToken}`},
});
```

Call `refresh()` unconditionally. It checks expiry itself and returns the
credential you passed when there is nothing to do, so `isRefreshNeeded()` is
only worth calling when you need the answer for its own sake.

## When a refresh happens

`isRefreshNeeded()` returns true only when the credential carries an `oauth2`
field with an `expiresAt`, and that instant has passed. `expiresAt` is
milliseconds since the epoch, and the check applies a 60 second leeway, so a
token is treated as expired one minute before its real deadline. A credential
without `expiresAt` is never refreshed.

## Failure modes

`OAuth2CredentialRefresher.refresh()` never throws. It returns the credential it
was given, silently, when the `oauth2` field or the auth scheme is missing. It
logs a warning and returns that credential when any of these is missing:

- `oauth2.refreshToken`;
- `oauth2.clientId` or `oauth2.clientSecret`;
- a token endpoint on the auth scheme.

A failing token request behaves the same way: the error is logged and the
original credential comes back. The stale token then draws a 401 from the API,
which restarts the interactive authorization flow — the outcome you want when
the refresh token itself has been revoked.

Your own refresher need not be so quiet. `BaseCredentialRefresher` documents
`CredentialRefresherError` as the failure signal for an implementation that
prefers to raise one, and both are exported for that purpose.

The token endpoint must be HTTPS and must not resolve to a loopback, private, or
cloud-metadata address. `fetchOAuth2Tokens` rejects anything else, and it does
not follow redirects, so a credential-bearing request cannot be bounced to
another host.
