# OAuth2 credential exchange for OpenAPI tools

An `OpenAPIToolset` secured with an OAuth2 or OpenID Connect scheme holds an
OAuth2 credential. ADK converts that credential into an HTTP bearer credential
before the request goes out, so the call carries an `Authorization` header.

## Introduction

Two different steps both carry the name "exchange", and they run one after the
other.

The first step _obtains_ a token. `OAuth2CredentialExchanger` in
`core/src/auth/oauth2/` runs the client-credentials or authorization-code grant
against the token endpoint. Its result is still an OAuth2 credential, and the
token sits in `oauth2.accessToken`.

The second step _converts_ that token into the form the wire needs.
`applyCredential` builds the `Authorization` header from `apiKey` or from
`http.credentials.token`. An OAuth2 credential matches neither, so on its own it
produces no header. `OAuth2CredentialExchanger` in
`core/src/tools/openapi_tool/auth/credential_exchangers/` returns a new
credential of type `AuthCredentialTypes.HTTP` with `http.scheme` set to
`bearer`, which `applyCredential` does send.

`AutoAuthCredentialExchanger` runs both steps for an `OAUTH2` or
`OPEN_ID_CONNECT` credential, so a toolset gets the behaviour without extra
wiring. `ToolAuthHandler` calls it for you on each tool call.

## Get started

This toolset is secured with an OpenID Connect scheme. The credential already
holds an access token, which is what an interactive consent flow leaves behind.

```ts
import {readFile} from 'node:fs/promises';
import {
  AuthCredentialTypes,
  OpenAPIToolset,
  type AuthCredential,
  type OpenIdConnectWithConfig,
} from '@google/adk';

const authScheme = {
  type: 'openIdConnect',
  openIdConnectUrl:
    'https://provider.example.com/.well-known/openid-configuration',
  authorizationEndpoint: 'https://provider.example.com/auth',
  tokenEndpoint: 'https://provider.example.com/token',
  scopes: ['openid', 'profile'],
} satisfies OpenIdConnectWithConfig;

const authCredential: AuthCredential = {
  authType: AuthCredentialTypes.OAUTH2,
  oauth2: {
    clientId: process.env.OAUTH_CLIENT_ID,
    clientSecret: process.env.OAUTH_CLIENT_SECRET,
    accessToken: process.env.OAUTH_ACCESS_TOKEN,
  },
};

const toolset = new OpenAPIToolset({
  specStr: await readFile('petstore.json', 'utf8'),
  specType: 'json',
  authScheme,
  authCredential,
});
```

Each tool in the toolset now sends `Authorization: Bearer <access token>`.

## Refresh

The exchanger refreshes the access token only when both conditions hold: the
credential carries a `refreshToken`, and the token is expired. Nothing else
reaches the network.

`oauth2.expiresAt` is milliseconds since the epoch, and a token counts as
expired 60 seconds before that time. This differs from adk-python, which stores
seconds.

A refresh that fails is not an error. The exchanger logs the failure and wraps
the existing token, so the provider decides whether the token is still good.

## Pass-through and errors

A credential that already carries `http` comes back unchanged, and so does an
OAuth2 credential with no access token. Neither case reaches the network.

`exchange` throws `CredentialExchangeError` for a scheme and credential pair it
cannot convert:

- the credential is missing;
- the scheme type is neither `oauth2` nor `openIdConnect`;
- the credential carries neither `oauth2` nor `http`.

The error propagates out of `AutoAuthCredentialExchanger`, unlike adk-python,
which logs it and continues.
