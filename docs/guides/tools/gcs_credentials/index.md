# GCSCredentialsConfig

`GCSCredentialsConfig` says how a tool authenticates against Cloud Storage. It
fills in the Cloud Storage OAuth2 scope and a Cloud Storage token cache key, so
you write neither by hand.

## Introduction

A Google API tool needs a credential before it can call anything, and there are
three ways to get one. The tool may already hold a credential that serves every
end user, such as a service account. The host application may put an access
token into session state. Or the tool may run an OAuth2 consent flow and ask the
end user directly. `BaseGoogleCredentialsConfig` models all three, accepts
exactly one of them, and rejects any other combination.

Two details of that base are per-API rather than generic. The first is the scope
set: an OAuth2 consent flow must name the scopes it wants, and the Cloud Storage
scope is `https://www.googleapis.com/auth/devstorage.full_control`. The second
is the session-state key the resolved credential is cached under. That key must
differ per API, or one Google tool's cached credential would be handed to
another tool that asked for different scopes.

`GCSCredentialsConfig` supplies both. It changes nothing else: the three
credential modes and their validation come from `BaseGoogleCredentialsConfig`
unchanged. This mirrors `integrations/gcs/gcs_credentials.py` in adk-python.

The configuration is inert data. It performs no network call and mints no token.
adk-js does not yet ship a Cloud Storage toolset, so today you read the
configuration inside a tool you write yourself.

## Get started

The smallest configuration is an OAuth2 client id and secret. The scope and the
cache key are filled in for you.

```ts
import {GCSCredentialsConfig} from '@google/adk';

const config = new GCSCredentialsConfig({
  clientId: process.env.OAUTH_CLIENT_ID,
  clientSecret: process.env.OAUTH_CLIENT_SECRET,
});

config.scopes; // ['https://www.googleapis.com/auth/devstorage.full_control']
config.tokenCacheKey; // 'gcs_token_cache'
```

## The three credential modes

Supply exactly one of these. The constructor throws `InputValidationError` for
any other combination.

```ts
import {GCSCredentialsConfig} from '@google/adk';
import {GoogleAuth} from 'google-auth-library';

// 1. A credential the tool already holds, used for every end user.
const auth = new GoogleAuth();
const serviceAccount = new GCSCredentialsConfig({
  credentials: await auth.getClient(),
});

// 2. An access token the host application puts into session state.
const hosted = new GCSCredentialsConfig({
  externalAccessTokenKey: 'user_access_token',
});

// 3. An OAuth2 client that drives the end user through a consent flow.
const consent = new GCSCredentialsConfig({
  clientId: process.env.OAUTH_CLIENT_ID,
  clientSecret: process.env.OAUTH_CLIENT_SECRET,
});
```

`scopes` is valid only alongside `clientId` and `clientSecret`. The other two
modes carry their own grant, so a scope list there is rejected.

## Scopes

`GCS_DEFAULT_SCOPE` is applied only when the resolved configuration carries no
scopes of its own. Scopes you pass yourself survive untouched.

```ts
import {GCS_DEFAULT_SCOPE, GCSCredentialsConfig} from '@google/adk';

const readOnly = new GCSCredentialsConfig({
  clientId: process.env.OAUTH_CLIENT_ID,
  clientSecret: process.env.OAUTH_CLIENT_SECRET,
  scopes: ['https://www.googleapis.com/auth/devstorage.read_only'],
});

readOnly.scopes; // ['https://www.googleapis.com/auth/devstorage.read_only']
GCS_DEFAULT_SCOPE; // ['https://www.googleapis.com/auth/devstorage.full_control']
```

An authorized-user credential from a previous consent flow already records what
the end user granted. In that case the granted scopes win over the default, and
the client id and secret are read off the credential too. A credential carrying
no OAuth2 identity, such as a metadata-server client, grants nothing to read, so
the Cloud Storage default applies.

Each instance receives its own copy of the default array, so mutating one
configuration's `scopes` does not affect the next one.

## The token cache key

Every instance sets `tokenCacheKey` to `GCS_TOKEN_CACHE_KEY`, the literal string
`gcs_token_cache`, whichever credential mode is in use. The constant is shared
with adk-python, so a session written by either SDK names the same key. The
configuration only records the key; the code that resolves a credential is what
reads and writes session state under it.

## Validation errors

The base validator runs first and throws `InputValidationError`. The three
messages are:

| Input                                                                                    | Message                                                                                                       |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `credentials` with any of `externalAccessTokenKey`, `clientId`, `clientSecret`, `scopes` | If credentials are provided, externalAccessTokenKey, clientId, clientSecret, and scopes must not be provided. |
| `externalAccessTokenKey` with any of `clientId`, `clientSecret`, `scopes`                | If externalAccessTokenKey is provided, clientId, clientSecret, and scopes must not be provided.               |
| No mode at all, or only one half of the client id and secret pair                        | Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair.                   |

The default scope is applied after that validator runs, never before. Applying
it first would make the pre-built credential and external token modes throw,
because the validator rejects `scopes` alongside either of them. adk-python
orders it the same way.
