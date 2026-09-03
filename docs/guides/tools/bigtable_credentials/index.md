# BigtableCredentialsConfig

Declares how a Cloud Bigtable tool obtains credentials. Reach for it when a tool
calls Bigtable and you must choose between a credential the tool already holds,
an access token the host supplies, and an OAuth2 consent flow run against the end
user.

## Introduction

`BigtableCredentialsConfig` is a specialization of `BaseGoogleCredentialsConfig`.
The base class carries the credential mode and validates it. The subclass adds
the two things that are specific to Bigtable: the default OAuth2 scopes, and the
session-state key the resolved credential is cached under.

The config is inert data. `GoogleCredentialsManager` is what reads it, refreshes
a stale token, and starts a consent flow when no usable credential exists. Keep
the two apart: build the config once when you construct the tool, then hand it to
a manager on each tool call.

Use the base class directly for a Google API that is not Bigtable. Use this
subclass for Bigtable, so two Bigtable tools share one cached grant instead of
minting a key each.

## Get started

The smallest configuration names an OAuth2 client. The scopes and the cache key
default.

```ts
import {BigtableCredentialsConfig, GoogleCredentialsManager} from '@google/adk';

const config = new BigtableCredentialsConfig({
  clientId: process.env.OAUTH_CLIENT_ID,
  clientSecret: process.env.OAUTH_CLIENT_SECRET,
});

config.scopes;
// [ 'https://www.googleapis.com/auth/bigtable.admin',
//   'https://www.googleapis.com/auth/bigtable.data' ]
config.tokenCacheKey; // 'bigtable_token_cache'

const credentials = await new GoogleCredentialsManager(
  config,
).getValidCredentials(toolContext);
```

`getValidCredentials` returns `undefined` when it asked the end user for consent.
The tool must return at that point, so the end user can respond.

## Credential modes

Name exactly one of three modes. Any other combination throws an
`InputValidationError` from the constructor.

| Mode              | Options                       | When to use it                                                                     |
| ----------------- | ----------------------------- | ---------------------------------------------------------------------------------- |
| Held credential   | `credentials`                 | The tool already holds a service account, application default, or user credential. |
| Host access token | `externalAccessTokenKey`      | The host put an access token in session state under that key.                      |
| OAuth2 client     | `clientId` and `clientSecret` | The tool calls Bigtable on the end user's behalf and must collect consent.         |

```ts
import {BigtableCredentialsConfig} from '@google/adk';
import {JWT} from 'google-auth-library';

// A service account the tool holds. No consent flow ever runs.
new BigtableCredentialsConfig({
  credentials: new JWT({email: serviceAccountEmail, key: privateKey}),
});

// An access token the host wrote to session state.
new BigtableCredentialsConfig({externalAccessTokenKey: 'host_access_token'});
```

`scopes` is valid only alongside `clientId` and `clientSecret`. The other two
modes carry their own grant, so a scope list there would be ignored.

## Scopes

`scopes` is always a non-empty array, resolved in this order:

1. The scopes already granted to a user credential passed as `credentials`.
2. The `scopes` you supplied.
3. A copy of `BIGTABLE_DEFAULT_SCOPE`.

Each instance owns its array, so mutating one config's `scopes` changes no other
config and does not change the exported constant.

## Token cache

`tokenCacheKey` is always `BIGTABLE_TOKEN_CACHE_KEY`, the string
`'bigtable_token_cache'`. Only a subclass can set it, so a caller cannot.

`GoogleCredentialsManager` reads that session-state key in the held-credential
and OAuth2-client modes, and writes the granted credential back after a consent
flow. It bypasses the cache entirely when `externalAccessTokenKey` is set, and
returns the host's token. The entry is JSON in the shape adk-python's
`Credentials.to_json()` writes, so a session written by either SDK is readable by
the other.

## Errors

The inherited validator throws `InputValidationError` for these three cases.

| Condition                                                                                | Message                                                                                                         |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `credentials` with any of `externalAccessTokenKey`, `clientId`, `clientSecret`, `scopes` | `If credentials are provided, externalAccessTokenKey, clientId, clientSecret, and scopes must not be provided.` |
| `externalAccessTokenKey` with any of `clientId`, `clientSecret`, `scopes`                | `If externalAccessTokenKey is provided, clientId, clientSecret, and scopes must not be provided.`               |
| No mode, or `clientId` without `clientSecret`                                            | `Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair.`                   |

`GoogleCredentialsManager` throws `InputValidationError` at call time when
`externalAccessTokenKey` names a session-state key that holds no token.

The class is experimental. It logs a warning once on first construction and it
may change.
