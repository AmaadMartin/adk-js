# BigtableCredentialsConfig

`BigtableCredentialsConfig` says how a tool authenticates against Cloud
Bigtable. It fills in the two Bigtable OAuth2 scopes and a Bigtable-specific
token cache key, so you do not write either by hand.

## Introduction

A Google API tool needs a credential before it can call anything, and there are
three ways to get one. The tool may already hold a credential that serves every
end user, such as a service account. The host application may put an access
token into session state. Or the tool may run an OAuth2 consent flow and ask the
end user directly. `BaseGoogleCredentialsConfig` models all three, accepts
exactly one of them, and rejects any other combination.

Two details of that base are per-API rather than generic. The first is the scope
set: an OAuth2 consent flow must name the scopes it wants, and the Bigtable
scopes are `bigtable.admin` and `bigtable.data`. The second is the session-state
key the resolved credential is cached under. That key must differ per API, or
one Google tool's cached credential would be handed to another tool that asked
for different scopes.

`BigtableCredentialsConfig` supplies both. It changes nothing else: the three
credential modes, their validation, the refresh path and the consent flow all
come from `BaseGoogleCredentialsConfig` unchanged. This mirrors
`bigtable_credentials.py` in adk-python.

The configuration is inert data. `GoogleCredentialsManager` is what reads it,
resolves a live credential, and writes the cache entry. adk-js does not yet ship
a Bigtable toolset, so today you pair the two yourself inside a tool you write.

## Get started

The smallest configuration is an OAuth2 client id and secret. The scopes and the
cache key are filled in for you. Hand the configuration to a
`GoogleCredentialsManager`, and it returns a credential your tool can call
Bigtable with.

```ts
import {BigtableCredentialsConfig, GoogleCredentialsManager} from '@google/adk';

const config = new BigtableCredentialsConfig({
  clientId: process.env.OAUTH_CLIENT_ID,
  clientSecret: process.env.OAUTH_CLIENT_SECRET,
});

config.scopes;
// [
//   'https://www.googleapis.com/auth/bigtable.admin',
//   'https://www.googleapis.com/auth/bigtable.data',
// ]
config.tokenCacheKey; // 'bigtable_token_cache'

const manager = new GoogleCredentialsManager(config);
```

Inside a tool, `getValidCredentials` takes the tool's `Context`. It returns the
credential, or `undefined` when it has asked the end user for consent and your
tool should return so they can answer.

```ts
const credentials = await manager.getValidCredentials(context);
if (!credentials) {
  return {status: 'awaiting user consent'};
}
```

## The three credential modes

Supply exactly one of these. The constructor throws `InputValidationError` for
any other combination.

```ts
import {BigtableCredentialsConfig} from '@google/adk';
import {GoogleAuth} from 'google-auth-library';

// 1. A credential the tool already holds, used for every end user.
const auth = new GoogleAuth();
const serviceAccount = new BigtableCredentialsConfig({
  credentials: await auth.getClient(),
});

// 2. An access token the host application puts into session state.
const hosted = new BigtableCredentialsConfig({
  externalAccessTokenKey: 'user_access_token',
});

// 3. An OAuth2 client that drives the end user through a consent flow.
const consent = new BigtableCredentialsConfig({
  clientId: process.env.OAUTH_CLIENT_ID,
  clientSecret: process.env.OAUTH_CLIENT_SECRET,
});
```

`scopes` is valid only alongside `clientId` and `clientSecret`. The other two
modes carry their own grant, so a scope list there is rejected.

## Scopes

`BIGTABLE_DEFAULT_SCOPE` is applied only when the resolved configuration carries
no scopes of its own. Scopes you pass yourself survive untouched, so you can ask
for read access alone.

```ts
import {BIGTABLE_DEFAULT_SCOPE, BigtableCredentialsConfig} from '@google/adk';

const narrow = new BigtableCredentialsConfig({
  clientId: process.env.OAUTH_CLIENT_ID,
  clientSecret: process.env.OAUTH_CLIENT_SECRET,
  scopes: ['https://www.googleapis.com/auth/bigtable.data'],
});

narrow.scopes; // ['https://www.googleapis.com/auth/bigtable.data']
BIGTABLE_DEFAULT_SCOPE.length; // 2
```

A credential from a previous consent flow already records what the end user
granted. In that case the granted scopes win over the default, and the client id
and secret are read off the credential too.

Each instance receives its own copy of the default array, so mutating one
configuration's `scopes` does not affect the next one.

## The token cache key

Every instance caches under `BIGTABLE_TOKEN_CACHE_KEY`, the literal string
`bigtable_token_cache`. The key is not yours to change:
`BigtableCredentialsConfigOptions` omits `tokenCacheKey`, so passing one is a
compile error. The entry written there is the JSON shape adk-python's
`Credentials.to_json()` writes, so a session started by either SDK is readable
by the other.

`GoogleCredentialsManager` reads that key in the held-credential and OAuth2
modes, and writes the granted credential back after a consent flow. It bypasses
the cache when `externalAccessTokenKey` is set, and returns the host's token.

## Validation errors

The base validator runs first and throws `InputValidationError`. The three
messages are:

| Input                                                                                    | Message                                                                                                       |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `credentials` with any of `externalAccessTokenKey`, `clientId`, `clientSecret`, `scopes` | If credentials are provided, externalAccessTokenKey, clientId, clientSecret, and scopes must not be provided. |
| `externalAccessTokenKey` with any of `clientId`, `clientSecret`, `scopes`                | If externalAccessTokenKey is provided, clientId, clientSecret, and scopes must not be provided.               |
| No mode at all, or only one half of the client id and secret pair                        | Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair.                   |

`GoogleCredentialsManager` throws `InputValidationError` at call time when
`externalAccessTokenKey` names a session-state key that holds no token.
