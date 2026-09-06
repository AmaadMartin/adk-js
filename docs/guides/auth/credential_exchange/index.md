# Credential exchangers

A credential exchanger turns the credential a user supplied into the credential
an API accepts. `ToolAuthHandler` runs one before an OpenAPI tool call, and
`AutoAuthCredentialExchanger` picks which one to run.

## Introduction

A user gives ADK the credential that is convenient to give: a service account
key, an OAuth2 authorization response, an API key. An API wants something else,
usually a bearer token in an `Authorization` header. The step between the two is
the exchange, and it differs per credential type.

`BaseCredentialExchanger` is the interface for one such step. Its `exchange`
method takes the auth scheme and the credential, and returns an `ExchangeResult`
holding the credential plus `wasExchanged`. `ToolAuthHandler` uses that flag to
decide what to cache: an exchange costs a round trip, so its result is worth
storing, while a static credential is not.

`AutoAuthCredentialExchanger` is the dispatcher. It reads
`authCredential.authType` and delegates. Three types have a built-in exchanger:

| Credential type   | Exchanger                           |
| ----------------- | ----------------------------------- |
| `OAUTH2`          | `OAuth2CredentialExchanger`         |
| `OPEN_ID_CONNECT` | `OAuth2CredentialExchanger`         |
| `SERVICE_ACCOUNT` | `ServiceAccountCredentialExchanger` |

Any other type has no entry, so the credential comes back unchanged with
`wasExchanged: false`. That is how an `API_KEY` credential reaches a tool
untouched. A missing credential is a caller error, so `exchange` throws
`CredentialExchangeError`.

## Get started

Write an exchanger by implementing `BaseCredentialExchanger`. This one converts
an API key into a bearer credential.

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

Register it in a `CredentialExchangerRegistry` and pass that to
`AutoAuthCredentialExchanger`. A registered exchanger takes priority over the
built-in one for the same credential type, and every type you do not register
keeps its built-in.

```ts
import {
  AuthCredentialTypes,
  AutoAuthCredentialExchanger,
  CredentialExchangerRegistry,
  ToolAuthHandler,
} from '@google/adk';

const registry = new CredentialExchangerRegistry();
registry.register(AuthCredentialTypes.API_KEY, new ApiKeyHeaderExchanger());

const handler = ToolAuthHandler.fromToolContext(
  context,
  authScheme,
  authCredential,
  {credentialExchanger: new AutoAuthCredentialExchanger(registry)},
);
```

`ToolAuthHandler` builds a plain `AutoAuthCredentialExchanger` when you pass no
`credentialExchanger`, so the built-in behaviour is the default.

## Failure modes

- Your exchanger throws. `AutoAuthCredentialExchanger` does not catch it, and
  the error propagates out of `prepareAuthCredentials`.
- The credential is absent. `exchange` throws `CredentialExchangeError` rather
  than reading `authType` off nothing.
- `OAuth2CredentialExchanger` needs the auth scheme and throws
  `CredentialExchangeError` without it. `AutoAuthCredentialExchanger` forwards
  the scheme it was given and does not check it, because another exchanger may
  not need one.
