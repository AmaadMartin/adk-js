# OAuth2 credential exchange

`OAuth2CredentialExchanger` turns an authorization response into an access
token. Reach for it when you hold an authorization code, or client credentials,
and you need a token a tool can send.

## Introduction

An OAuth2 provider does not hand you a token directly. It hands you an
authorization code, or it accepts a client id and secret. Something must call
the token endpoint and trade one for the other. That is what this exchanger
does, and `AuthHandler` and `ToolAuthHandler` both call it for you.

The exchange talks to a remote server, so it fails for ordinary reasons: the
endpoint is down, the code expired, or the client was configured without a
secret. The exchanger treats those as a degraded result, not an error. It logs
the reason and returns your original credential with `wasExchanged: false`. A
caller can then skip the authenticated call rather than crash the whole tool
invocation.

Two conditions still reject, because neither is a transient failure:

- A missing `authScheme`. The exchanger cannot know which endpoint to call.
- A state mismatch between `authResponseUri` and the `state` you stored. This
  is the cross-site request forgery check, and a mismatch must stop the flow.

## Get started

```ts
import {
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  OAuth2CredentialExchanger,
} from '@google/adk';

const authScheme: AuthScheme = {
  type: 'openIdConnect',
  openIdConnectUrl:
    'https://provider.example.com/.well-known/openid-configuration',
  authorizationEndpoint: 'https://provider.example.com/authorize',
  tokenEndpoint: 'https://provider.example.com/token',
  scopes: ['openid'],
};

const authCredential: AuthCredential = {
  authType: AuthCredentialTypes.OAUTH2,
  oauth2: {
    clientId: process.env.OAUTH_CLIENT_ID,
    clientSecret: process.env.OAUTH_CLIENT_SECRET,
    redirectUri: 'http://localhost:8080/callback',
    authResponseUri: 'http://localhost:8080/callback?code=the_code',
  },
};

const result = await new OAuth2CredentialExchanger().exchange({
  authCredential,
  authScheme,
});

if (result.wasExchanged) {
  callTheApi(result.credential.oauth2?.accessToken);
} else {
  callTheApiWithoutAuth();
}
```

## Choosing the grant

`exchange` picks the grant from the scheme, so you do not pass one:

- An `oauth2` scheme uses its `flows`. `clientCredentials` wins over
  `authorizationCode`.
- An `openIdConnect` scheme uses `grantTypesSupported`. It uses the
  client-credentials grant when that list contains `client_credentials`, and
  the authorization-code grant otherwise. A scheme that omits the list still
  gets the authorization-code grant.

A scheme that carries neither `flows` nor `grantTypesSupported`, and is not
`openIdConnect`, produces no grant. The exchanger logs a warning and returns the
credential unexchanged.

## What the result guarantees

- `wasExchanged: true` means `credential.oauth2.accessToken` holds a token.
- `wasExchanged: false` means `credential` is the object you passed in.
  Comparing it by reference to your own credential succeeds.
- The exchanger never edits your credential. A successful exchange returns a
  copy.
- No secret, token, or authorization code reaches a log line.

## Authorization response URIs

Pass the full redirect you received as `oauth2.authResponseUri`. The exchanger
reads the code out of it, so you do not have to. Some providers append an empty
fragment, as in `...?code=the_code#`; the exchanger drops that single trailing
`#` before it parses the URI.

Set `oauth2.state` to the value you sent on the authorization request. When both
`state` and `authResponseUri` are present, the exchanger compares them and
throws `CredentialExchangeError` if they differ.

## There is no synchronous exchange

`exchange` returns a promise; there is no blocking variant.
