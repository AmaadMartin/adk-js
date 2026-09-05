# GcpAuthProvider and Agent Identity credentials

`GcpAuthProvider` fetches an end-user credential from the Google Cloud Agent
Identity Credentials service. Reach for it when a tool calls a third-party API
on the user's behalf and you do not want to write the OAuth flow yourself.

## Introduction

A tool that reads someone's Jira issues needs a token that belongs to that
person. Getting one means running a consent flow: send the user to an
authorization page, wait, and come back with a token. Agent Identity runs that
flow for you. You create an auth provider resource in Google Cloud, point a
scheme at it, and ask ADK for the credential.

A `GcpAuthProviderScheme` names the resource:

```ts
import {GcpAuthProviderScheme} from '@google/adk';

const authScheme: GcpAuthProviderScheme = {
  type: 'gcpAuthProviderScheme',
  name: 'projects/my-project/locations/global/authProviders/jira',
  scopes: ['https://www.example.com/auth/issues.read'],
  continueUri: 'https://my-agent.example.com/oauth/continue',
};
```

`AgentRegistry.getMcpToolset` already builds a scheme in this shape when the
registry binding names an auth provider. `GcpAuthProvider` is the piece that
turns such a scheme into a credential.

The service answers in one of four states, and the provider maps each one:

- **Credentials available.** You get an `AuthCredential` of type `HTTP`.
- **Consent required.** You get an `AuthCredential` of type `OAUTH2` carrying
  `authUri` and `nonce`. Send the user to `authUri`; they return to your
  `continueUri`.
- **Pending.** The provider polls once a second for ten seconds, then rejects.
- **Consent rejected.** The provider rejects.

## Get started

Register the provider once, under the scheme's `type`, then ask it for a
credential:

```ts
import {
  AuthCredential,
  AuthProviderRegistry,
  Context,
  GcpAuthProvider,
  GcpAuthProviderScheme,
} from '@google/adk';

const registry = new AuthProviderRegistry();
registry.register('gcpAuthProviderScheme', new GcpAuthProvider());

async function fetchCredential(
  scheme: GcpAuthProviderScheme,
  context: Context,
): Promise<AuthCredential> {
  const provider = new GcpAuthProvider();
  return provider.getAuthCredential(
    {authScheme: scheme, credentialKey: 'jira'},
    context,
  );
}
```

A `GcpAuthProviderScheme` goes straight into an `AuthConfig`, because
`AuthScheme` admits any scheme extending `CustomAuthScheme`.

ADK does not resolve a `gcpAuthProviderScheme` on its own yet: nothing in the
framework reads `AuthProviderRegistry`. Your application asks the provider for
the credential and applies it.

## The credential you get back

The service returns a header name and a token. The provider reads the header to
decide the credential shape.

An `Authorization: Bearer` header becomes a bearer credential:

```ts
{
  authType: AuthCredentialTypes.HTTP,
  http: {scheme: 'Bearer', credentials: {token: '<token>'}},
}
```

Any other header name is sent verbatim, alongside `X-GOOG-API-KEY`:

```ts
{
  authType: AuthCredentialTypes.HTTP,
  http: {
    scheme: '',
    credentials: {},
    additionalHeaders: {'x-api-key': '<token>', 'X-GOOG-API-KEY': '<token>'},
  },
}
```

When consent is still outstanding you get an OAuth2 credential instead:

```ts
{
  authType: AuthCredentialTypes.OAUTH2,
  oauth2: {authUri: 'https://...', nonce: '...'},
}
```

Ask again after the user consents, and the same call returns the token. Ask
again while consent is still outstanding, and you get a fresh `authUri`.

## Configuration

The provider authenticates to the service with Application Default Credentials
and the `https://www.googleapis.com/auth/cloud-platform` scope. Set
`GOOGLE_APPLICATION_CREDENTIALS`, or run where ADC is already available.

Set `AGENT_IDENTITY_CREDENTIALS_TARGET_HOST` to send requests somewhere other
than `agentidentitycredentials.googleapis.com`. The provider reads it when it
builds its client.

You can replace the whole backend, which is how the unit tests drive the router
without a network:

```ts
import {
  AuthCredentialTypes,
  CredentialsProvider,
  GcpAuthProvider,
} from '@google/adk';

const agentIdentityProvider: CredentialsProvider = {
  async getAuthCredential() {
    return {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'Bearer', credentials: {token: 'test-token'}},
    };
  },
};
const provider = new GcpAuthProvider({agentIdentityProvider});
```

## Failure modes

Every failure rejects with an `Error`.

| Condition                                     | Message                                                                                                   |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| The scheme is not a `gcpAuthProviderScheme`   | `Expected GcpAuthProviderScheme, got <type>`                                                              |
| No context, or no user id                     | `GcpAuthProvider requires a context with a valid user_id.`                                                |
| The service call failed                       | `Failed to retrieve credential for user '<id>' on provider '<name>'.`, with the original error as `cause` |
| The user refused consent                      | `Operation failed: User consent rejected.`                                                                |
| The service returned an empty header or token | `Received either empty header or token from Agent Identity Credentials service.`                          |
| Polling ran out of time                       | The `Failed to retrieve credential` message, with `Timeout waiting for credentials.` as `cause`           |
| Consent completed but no credential followed  | `Failed to retrieve consent based credential.`                                                            |
| The service returned none of the four states  | `Agent Identity Credentials service returned an unsupported state.`                                       |

## IAM connector resource names

A scheme naming `projects/<p>/locations/<l>/connectors/<c>` routes to a separate
delegate. adk-js has no IAM Connector Credentials client, so the provider
rejects unless you pass your own:

```ts
new GcpAuthProvider({iamConnectorProvider: myConnectorProvider});
```

## Testing it against the real service

There is no automated end-to-end test: every path needs a real auth provider
resource and a person to click through consent. To check it by hand:

1.  Create an auth provider resource in your Google Cloud project.
2.  Point a `GcpAuthProviderScheme` at it, with a `continueUri` your app serves.
3.  Ask `GcpAuthProvider` for the credential. The first call returns an OAuth2
    credential carrying `authUri`.
4.  Open `authUri`, grant consent, and let the browser return to `continueUri`.
5.  Ask again. You now get an HTTP credential carrying the token.
