# CredentialManager

`CredentialManager` resolves the credential an authenticated tool runs with. It
validates the tool's `AuthConfig`, loads a stored credential, exchanges or
refreshes it, and saves the result. Reach for it when you write a tool that
calls an authenticated API.

## Introduction

A tool that calls a third-party API needs a working credential at the moment it
runs. Getting one is not a single step. The configured credential may be usable
as it is, or it may be an OAuth2 client id and secret that must be exchanged for
a token. A token from a previous turn may have expired. The end user may not
have authorized anything yet, in which case the tool cannot run at all.

`CredentialManager` runs that whole sequence once, so a tool does not repeat it.
It sits between three pieces the repository already has. `AuthConfig`, from
`auth_tool.ts`, says which scheme the API uses and which credential you
configured. A `BaseCredentialService` stores the resolved credential between
turns. A `BaseCredentialExchanger` and a `BaseCredentialRefresher` do the
protocol work for one credential type.

The manager returns `undefined` when the end user still has to authorize. That
is a control signal, not an error: call `requestCredential` and the invocation
pauses until the client answers.

## Get started

```ts
import {
  AuthConfig,
  AuthCredentialTypes,
  Context,
  CredentialManager,
} from '@google/adk';

const authConfig: AuthConfig = {
  authScheme: {
    type: 'oauth2',
    flows: {
      authorizationCode: {
        authorizationUrl: 'https://provider.example.com/authorize',
        tokenUrl: 'https://provider.example.com/token',
        scopes: {'documents.read': 'Read your documents'},
      },
    },
  },
  rawAuthCredential: {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {clientId: 'YOUR_CLIENT_ID', clientSecret: 'YOUR_CLIENT_SECRET'},
  },
  credentialKey: 'documents-api',
};

async function resolveCredential(context: Context) {
  const manager = new CredentialManager(authConfig);
  const credential = await manager.getAuthCredential(context);
  if (!credential) {
    manager.requestCredential(context);
    return undefined;
  }
  return credential;
}
```

Pass a credential service to the `Runner` so the resolved credential survives
the turn. Without one the manager still works, but it resolves the credential
again on every call.

## Resolution order

`getAuthCredential` runs these steps in order and stops at the first that
produces a credential.

1. A scheme outside the OpenAPI 3.0 set goes to its registered auth provider,
   and nothing below runs.
2. The config is validated, and an OAuth2 endpoint that is declared but empty is
   filled from the issuer's published metadata.
3. An `apiKey` or `http` raw credential is returned as a copy.
4. The credential service is asked for a stored credential.
5. The auth response in session state is read.
6. A client-credentials flow falls back to a copy of the raw credential.
   Anything else returns `undefined`, so the client is asked for consent.
7. The credential is exchanged. If no exchange happened, it is refreshed.
8. A credential that changed is saved through the credential service.

A `serviceAccount` credential is never read from, nor written to, the credential
service. Its token is minted per exchange.

## Extension points

Register an exchanger or a refresher on one manager, for one credential type:

```ts
manager.registerCredentialExchanger(AuthCredentialTypes.API_KEY, myExchanger);
manager.registerCredentialRefresher(AuthCredentialTypes.API_KEY, myRefresher);
```

The manager already registers `OAuth2CredentialExchanger` for `OAUTH2` and
`OPEN_ID_CONNECT`, `ServiceAccountCredentialExchanger` for `SERVICE_ACCOUNT`,
and `OAuth2CredentialRefresher` for `OAUTH2` and `OPEN_ID_CONNECT`. Registering
a type again replaces the default.

An auth scheme the OpenAPI 3.0 specification does not define needs a provider.
Register it once per process, and the manager routes every scheme carrying that
`type` to it:

```ts
import {AuthConfig, AuthCredential, BaseAuthProvider} from '@google/adk';

class AcmeVaultAuthProvider implements BaseAuthProvider {
  readonly supportedAuthSchemes = ['acmeVault'] as const;

  async getAuthCredential(
    authConfig: AuthConfig,
  ): Promise<AuthCredential | undefined> {
    return readFromVault(authConfig.credentialKey);
  }
}

CredentialManager.registerAuthProvider(new AcmeVaultAuthProvider());
```

The first provider registered for a scheme type wins. A different provider for
that type logs a warning and is ignored. Registering the same instance again
does nothing.

A provider can also ask the end user to authorize. Return a credential whose
`oauth2` block carries an `authUri` and no `accessToken`, and the manager puts
it on `authConfig.exchangedAuthCredential` and resolves to `undefined`.

## Discovery

An OAuth2 scheme can name its issuer instead of listing its endpoints:

```ts
import {ExtendedOAuth2} from '@google/adk';

const authScheme: ExtendedOAuth2 = {
  type: 'oauth2',
  issuerUrl: 'https://provider.example.com',
  flows: {
    authorizationCode: {authorizationUrl: '', tokenUrl: '', scopes: {}},
  },
};
```

The manager fills the empty endpoints from the issuer's metadata during
validation, and leaves any endpoint you already set alone. Discovery goes
through `OAuth2DiscoveryManager`, which requires HTTPS, refuses redirects, and
blocks loopback, private and cloud-metadata addresses.

## Failure modes

| Condition                                           | Behaviour                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| A custom scheme with no registered provider         | Throws, and the message names the scheme type.                          |
| A provider that returns nothing                     | Throws `AuthProvider did not return a credential.`                      |
| An OAuth2 or OIDC scheme with no raw credential     | Throws, and the message names the scheme type.                          |
| An OAuth2 or OIDC credential with no `oauth2` block | Throws, and the message names the credential type.                      |
| An empty flow endpoint that discovery cannot fill   | Throws, and the message names the field path.                           |
| A context that cannot request a credential          | `requestCredential` throws a `TypeError`.                               |
| A discovery fetch that fails                        | Swallowed by `OAuth2DiscoveryManager`, and surfaces as the throw above. |
| An exchange or a refresh that fails                 | The exchanger's or refresher's own error propagates unchanged.          |

`CredentialManager` is experimental. It warns once on first use, and its API may
change.
