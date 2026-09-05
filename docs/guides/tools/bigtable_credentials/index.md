# BigtableCredentialsConfig

`BigtableCredentialsConfig` declares how Bigtable tools obtain Google
credentials. Reach for it when you build Bigtable tooling and must say which
identity the tools run under: an OAuth client you drive an end-user consent
flow with, an auth client you already hold, or an access token your host parked
in tool context state.

## Introduction

A Google toolset needs three answers before it can call an API: which identity
to use, which OAuth scopes to request, and where to cache the resolved token.
`BaseGoogleCredentialsConfig` answers the first. It accepts exactly one of
three authentication modes and rejects any combination of them.

| Mode              | Field                         | Who the tools act as                      |
| ----------------- | ----------------------------- | ----------------------------------------- |
| End-user OAuth    | `clientId` and `clientSecret` | Each end user, after consent.             |
| A client you hold | `credentials`                 | One identity, shared by every end user.   |
| An external token | `externalAccessTokenKey`      | Whoever your host obtained the token for. |

`BigtableCredentialsConfig` answers the other two. It defaults the scopes to
`BIGTABLE_DEFAULT_SCOPE` and pins the token cache key to
`BIGTABLE_TOKEN_CACHE_KEY`. The cache key is what keeps a Bigtable token
separate from a token another Google toolset resolved, so one toolset cannot
serve a request with another toolset's narrower or broader grant.

The class is a port of adk-python's
`google.adk.tools.bigtable.bigtable_credentials`. The two SDKs use the same
cache key and the same scope list, so a session one writes stays readable by
the other.

## Get started

The smallest configuration names an OAuth client and takes the defaults:

```ts
import {BigtableCredentialsConfig} from '@google/adk';

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
```

To share one identity across every end user, pass an auth client instead. This
is the Application Default Credentials path:

```ts
import {BigtableCredentialsConfig} from '@google/adk';
import {GoogleAuth} from 'google-auth-library';

const config = new BigtableCredentialsConfig({
  credentials: await new GoogleAuth().getClient(),
});
```

To use a token your host already obtained, name the tool context state key that
holds it:

```ts
import {BigtableCredentialsConfig} from '@google/adk';

const config = new BigtableCredentialsConfig({
  externalAccessTokenKey: 'my_bigtable_token',
});
```

## Scopes

The two default scopes apply when you pass no scopes, and also when you pass an
empty list. Naming your own scopes replaces both defaults, so include every
scope the tools need:

```ts
import {BigtableCredentialsConfig} from '@google/adk';

const config = new BigtableCredentialsConfig({
  clientId: process.env.OAUTH_CLIENT_ID,
  clientSecret: process.env.OAUTH_CLIENT_SECRET,
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});
```

A config that takes the defaults gets its own copy, so mutating `config.scopes`
cannot change `BIGTABLE_DEFAULT_SCOPE` or another config's scopes. A `scopes`
array you pass in is stored by reference, as the other options are, so two
configs built from one options object share that array. Pass a fresh array to
each config if you intend to mutate it later.

Scopes are read-only in one case. When `credentials` is an authorized-user
client that already carries a grant, the base class adopts that client's OAuth
client id, client secret and granted scopes, and the defaults do not apply. The
client's `scope` string is one space-delimited value, so the config splits it
into a list. A client with no OAuth client details — a service account client
or the metadata-server client — carries no identity to adopt, so the config
keeps the defaults.

## Failure modes

The constructor throws `InputValidationError` when the options name no
authentication mode, or more than one:

| Options                                                                                         | Message                                                                                                         |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `credentials` with `externalAccessTokenKey`, `clientId`, `clientSecret` or a non-empty `scopes` | `If credentials are provided, externalAccessTokenKey, clientId, clientSecret, and scopes must not be provided.` |
| `externalAccessTokenKey` with `clientId`, `clientSecret` or a non-empty `scopes`                | `If externalAccessTokenKey is provided, clientId, clientSecret, and scopes must not be provided.`               |
| No mode, or a client id without its secret                                                      | `Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair.`                   |

An empty `scopes: []` is not a conflict. It reads as "no scopes named", so
`{credentials, scopes: []}` is valid.

## What this config does not do

The config holds a declaration. It performs no network call, resolves no token
and writes nothing to tool context state. The Bigtable toolset that consumes it
is a separate port and is not in this package yet.
