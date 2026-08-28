# Bigtable credentials

`BigtableCredentialsConfig` declares where a Cloud Bigtable tool gets its
Google credential, which scopes it requests, and where it caches the resolved
token. Reach for it when you write a tool against the Bigtable API.

## Introduction

A Google API tool needs a credential, and where that credential comes from
differs per deployment. A service on Google Cloud uses Application Default
Credentials. A hosting application that already signed the user in has an
access token to hand over. An agent acting for an end user has to send that
user through an OAuth consent screen.

`BaseGoogleCredentialsConfig` names the source. It takes exactly one of those
three combinations and rejects anything else, so a misconfiguration fails at
construction rather than on the first API call.

`BigtableCredentialsConfig` adds the two answers every Bigtable tool needs to
give the same way: the Bigtable admin and data scopes, and the token cache key
`bigtable_token_cache`. Fixing them here is what stops two Bigtable tools
drifting apart, or sharing a cache slot with an unrelated toolset. Both values
match adk-python, so a session written by either SDK is readable by the other.

The config is a declaration and nothing more. It performs no network call and
touches no session state. A credentials manager reads it and resolves the live
client; that manager is not in adk-js yet, so today the config is what you
build and pass on.

## Get started

```ts
import {BigtableCredentialsConfig} from '@google/adk';
import {GoogleAuth} from 'google-auth-library';

// Application Default Credentials. Run `gcloud auth application-default
// login` first. No end user goes through a consent screen.
const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/bigtable.data'],
});
const config = new BigtableCredentialsConfig({
  credentials: await auth.getClient(),
});
```

The other two sources:

```ts
// An OAuth client, so each end user authorizes for themselves. The Bigtable
// scopes are filled in, so you do not name them.
new BigtableCredentialsConfig({
  clientId: process.env.OAUTH_CLIENT_ID,
  clientSecret: process.env.OAUTH_CLIENT_SECRET,
});

// An access token the hosting application wrote to session state.
new BigtableCredentialsConfig({
  externalAccessTokenKey: 'bigtable_access_token',
});
```

## Scopes

`scopes` defaults to `BIGTABLE_DEFAULT_SCOPE`, which holds the Bigtable admin
scope and the Bigtable data scope. Name `scopes` yourself to narrow that, for
example to the data scope alone:

```ts
new BigtableCredentialsConfig({
  clientId: process.env.OAUTH_CLIENT_ID,
  clientSecret: process.env.OAUTH_CLIENT_SECRET,
  scopes: ['https://www.googleapis.com/auth/bigtable.data'],
});
```

Each config gets its own copy of the default list, so mutating one config's
`scopes` does not reach another.

Two cases resolve the scopes elsewhere:

- A `credentials` client that carries an OAuth identity lends its client id,
  client secret and granted scopes to the config, and the Bigtable default does
  not apply. A service account or metadata credential carries none of these, so
  it keeps the default.
- An `externalAccessTokenKey` config gets the default scopes, even though
  passing `scopes` alongside that key is rejected. Validation runs before the
  default is applied.

## Rejected combinations

The constructor throws `InputValidationError` when the options are not one of
the three sources:

```ts
new BigtableCredentialsConfig({}); // throws
new BigtableCredentialsConfig({clientId: 'abc'}); // throws, no client secret
new BigtableCredentialsConfig({
  credentials,
  clientId: 'abc',
  clientSecret: 'def',
}); // throws
```

An empty `scopes` array counts as no scopes, so `{credentials, scopes: []}` is
accepted and the default applies.

## Token cache key

`tokenCacheKey` is set to `BIGTABLE_TOKEN_CACHE_KEY`
(`'bigtable_token_cache'`) and is not a constructor option. Use
`BaseGoogleCredentialsConfig` directly when you need a different key.
