# Credential exchangers

A credential exchanger turns the credential a user supplied into the credential
an API accepts. The OpenAPI tool path runs one before it calls a tool, and
`AutoAuthCredentialExchanger` picks which one to run.

## Introduction

A user gives ADK the credential that is convenient to give: a service account
key, an OAuth2 authorization response, an API key. An API wants something else,
usually a bearer token in an `Authorization` header. The step between the two is
the exchange, and it differs per credential type. A service account key becomes
an access token through the Google auth library. An OAuth2 authorization
response becomes an access token through the provider's token endpoint. An API
key needs no exchange at all.

`BaseCredentialExchanger` is the interface for one such step. It has a single
`exchange` method that takes the auth scheme and the credential, and returns an
`ExchangeResult`. The result carries the credential plus `wasExchanged`, which
tells the caller whether anything changed. `ToolAuthHandler` uses that flag to
decide what to cache: an exchange costs a round trip, so its result is worth
storing, while a static credential is not.

`AutoAuthCredentialExchanger` is the dispatcher. It holds a table that maps a
credential type to an exchanger, reads `authCredential.authType`, and delegates.
The built-in table covers three types:

| Credential type   | Exchanger                           |
| ----------------- | ----------------------------------- |
| `OAUTH2`          | `OAuth2CredentialExchanger`         |
| `OPEN_ID_CONNECT` | `OAuth2CredentialExchanger`         |
| `SERVICE_ACCOUNT` | `ServiceAccountCredentialExchanger` |

Any other type has no entry, so the credential comes back unchanged with
`wasExchanged: false`. That is how an `API_KEY` credential reaches a tool
untouched. A missing credential is a caller error, not a passthrough, so
`exchange` throws `CredentialExchangeError`.

## Get started

Write an exchanger by implementing `BaseCredentialExchanger`. This one converts
an API key into the bearer credential an API expects.

```ts
import {
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  BaseCredentialExchanger,
  CredentialExchangeError,
  ExchangeResult,
} from '@google/adk';

export class ApiKeyHeaderExchanger implements BaseCredentialExchanger {
  async exchange(params: {
    authScheme?: AuthScheme;
    authCredential: AuthCredential;
  }): Promise<ExchangeResult> {
    const {authCredential} = params;

    if (authCredential.authType !== AuthCredentialTypes.API_KEY) {
      throw new CredentialExchangeError(
        'ApiKeyHeaderExchanger only accepts an apiKey credential.',
      );
    }

    return {
      credential: {
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'bearer',
          credentials: {token: authCredential.apiKey ?? ''},
        },
      },
      wasExchanged: true,
    };
  }
}
```

## Custom exchangers

`AutoAuthCredentialExchanger` takes a table of exchangers keyed by credential
type. The table merges over the built-in one, so an entry for a type with no
built-in adds a route, and an entry for a type that has one replaces it.

```ts
// Add a route for a type the built-in table does not cover.
const exchanger = new AutoAuthCredentialExchanger({
  [AuthCredentialTypes.API_KEY]: new ApiKeyHeaderExchanger(),
});

// Replace a built-in.
const exchanger = new AutoAuthCredentialExchanger({
  [AuthCredentialTypes.OAUTH2]: new MyOAuth2Exchanger(),
});
```

Adding one entry keeps the rest of the table. The example above still routes
`OPEN_ID_CONNECT` and `SERVICE_ACCOUNT` to their built-in exchangers.

`AutoAuthCredentialExchanger` is internal to `@google/adk` and is not exported
from the package entry point. `ToolAuthHandler` constructs it with no arguments,
so the built-in table is what the OpenAPI tool path uses today.

## Failure modes

- The exchanger you register throws. `AutoAuthCredentialExchanger` does not
  catch it, so the error reaches the caller. `ToolAuthHandler` lets it
  propagate out of `prepareAuthCredentials`.
- The credential is absent. `exchange` throws `CredentialExchangeError` rather
  than reading `authType` off nothing.
- `OAuth2CredentialExchanger` needs the auth scheme and throws
  `CredentialExchangeError` without it. `AutoAuthCredentialExchanger` forwards
  the scheme it was given and does not check it, because a different exchanger
  may not need one.
