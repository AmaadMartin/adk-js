# AuthCredential and its helpers

`AuthCredential` holds the secret a tool needs to call a third-party API. The
helpers in `auth_credential.ts` build one with the right defaults, reject a
configuration that cannot work, and produce a log-safe view of one.

## Introduction

`AuthCredential` and its four nested shapes -- `HttpAuth`, `HttpCredentials`,
`OAuth2Auth` and `ServiceAccount` -- are plain TypeScript interfaces. You build
them as object literals, and nothing runs when you do. That keeps construction
cheap, but it leaves three jobs to the caller.

The first job is defaults. `OAuth2Auth.tokenEndpointAuthMethod` selects how the
client authenticates at the token endpoint. An interface cannot carry a default,
so `createOAuth2Auth` supplies one.

The second job is validation. A `ServiceAccount` with no credential and no
`useDefaultCredential` cannot be exchanged for a token, and neither can one that
asks for an ID token without an audience. `validateServiceAccount` reports both
at construction, where the mistake is, rather than at the exchange.

The third job is redaction, and it is the one with teeth. A credential holds a
client secret, a refresh token, or a private key. Anything that logs the object,
or serializes it into an error, writes those to disk. `redactAuthCredential`
returns a copy with the secrets removed. It is default-deny: a key this module
does not declare keeps its name but loses its value, so a provider-specific
field cannot leak by being unknown.

## Get started

```ts
import {
  AuthCredential,
  AuthCredentialTypes,
  createOAuth2Auth,
  redactAuthCredential,
} from '@google/adk';

const credential: AuthCredential = {
  authType: AuthCredentialTypes.OAUTH2,
  oauth2: createOAuth2Auth({
    clientId: 'my_client_id',
    clientSecret: 'top_secret_client_secret',
    redirectUri: 'http://localhost:8080/callback',
  }),
};

// 'client_secret_basic'
credential.oauth2?.tokenEndpointAuthMethod;

// {"authType":"oauth2","oauth2":{"clientId":"my_client_id",
//  "redirectUri":"http://localhost:8080/callback",
//  "tokenEndpointAuthMethod":"client_secret_basic"}}
JSON.stringify(redactAuthCredential(credential));
```

## What each helper does

### createOAuth2Auth

Returns a new `OAuth2Auth` with `tokenEndpointAuthMethod` filled in from
`DEFAULT_TOKEN_ENDPOINT_AUTH_METHOD` when the caller omits it. The argument is
not modified, and every other field passes through. The four accepted values are
`client_secret_basic`, `client_secret_post`, `client_secret_jwt` and
`private_key_jwt`, typed as `TokenEndpointAuthMethod`.

### validateServiceAccount and createServiceAccount

`validateServiceAccount` throws on the two configurations that cannot produce a
token:

```ts
import {validateServiceAccount} from '@google/adk';

// Error: serviceAccountCredential is required when useDefaultCredential is
// false.
validateServiceAccount({});

// Error: audience is required when useIdToken is true. Set it to the URL of
// the target service (e.g. 'https://my-service.run.app').
validateServiceAccount({useIdToken: true, serviceAccountCredential: key});
```

`createServiceAccount` validates and returns the same configuration, so you can
use it where the object is built.

Neither message contains any part of the credential.

### toHttpCredentials

Builds `HttpCredentials` from an untyped record, such as a parsed provider
response. It keeps `username`, `password` and `token`, and drops every other
key, so an unexpected secret cannot ride along inside the credential.

```ts
import {toHttpCredentials} from '@google/adk';

toHttpCredentials({token: 'abc', tenant_id: 'xyz'}); // {token: 'abc'}
```

A field that is absent, `undefined` or `null` is omitted from the result. A
present field that is not a string throws, and the message names the field and
its type but never its value.

### redactAuthCredential

Returns a new plain object safe to log. It applies three rules to the credential
and to each nested object:

- A declared secret field is dropped. That is `apiKey`,
  `HttpAuth.additionalHeaders`, `HttpCredentials.password` and `token`, the
  `OAuth2Auth` secrets (`clientSecret`, `authResponseUri`, `authCode`,
  `accessToken`, `refreshToken`, `idToken`, `codeVerifier`), and
  `ServiceAccountCredential.privateKeyId` and `privateKey`.
- A key the module does not declare keeps its name and gets the value
  `REDACTED`, which is the string `<redacted>`. The name stays so that the
  redaction is visible while you debug.
- Every other declared field passes through unchanged.

The argument is not modified, so the secrets stay readable on the credential you
hold. TypeScript has no hook that runs when an object is printed, so call this
yourself at the point you log a credential or put one into an error.
