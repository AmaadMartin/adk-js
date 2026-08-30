# ToolAuthHandler and the OpenAPI tool credential

`ToolAuthHandler` gives an OpenAPI tool the credential it calls its API with.
It reads a credential the tool already obtained, refreshes it when the access
token expired, and asks the client for a new one when there is none.

## Introduction

`RestApiTool` calls a third-party API. The API declares how it authenticates,
as an OpenAPI security scheme, and the tool is configured with a credential for
it. Between those two things sits a small amount of work that every call
repeats: find the credential this tool obtained earlier, notice that its access
token expired, exchange an OAuth2 credential into something an HTTP request can
carry, and pause the run when only the user can supply what is missing.
`ToolAuthHandler` is that work. `RestApiTool` calls it first on every
invocation and does nothing else until it answers.

The handler answers with an `AuthPreparationResult`. `state: 'done'` carries the
credential to call the API with. `state: 'pending'` means the handler asked the
client for a credential, and the tool returns without calling the API. The run
resumes on a later turn, when the client has answered.

Three collaborators do the actual work, and each one is replaceable:

- A `CredentialStore` holds the credential between tool calls. The default,
  `ToolContextCredentialStore`, keeps it in session state.
- A `BaseCredentialExchanger` converts the credential into one the API
  accepts. The default, `AutoAuthCredentialExchanger`, picks an exchanger from
  the credential type.
- `OAuth2CredentialRefresher` renews an expired OAuth2 access token.

## Get started

This tool authenticates against an API key. The handler has no credential on
the first call, so it asks the client for one.

```ts
import {Context, ToolAuthHandler, type AuthScheme} from '@google/adk';

const authScheme: AuthScheme = {
  type: 'apiKey',
  name: 'X-API-Key',
  in: 'header',
};

async function callWeatherApi(context: Context) {
  const handler = ToolAuthHandler.fromToolContext(context, authScheme);
  const result = await handler.prepareAuthCredentials();

  if (result.state === 'pending') {
    return {pending: true, message: 'Needs your authorization.'};
  }

  return fetch('https://weather.example.com/today', {
    headers: {'X-API-Key': result.authCredential?.apiKey ?? ''},
  });
}
```

`fromToolContext` needs a `Context` from inside a tool call, because requesting
a credential is filed under the id of the call that waits for it. A context
with no `functionCallId` throws.

## Naming the credential slot

The handler derives a key from a digest of the scheme and the credential, and
stores the credential under it. Two tools that declare the same scheme type
against different OAuth2 apps therefore get their own slot, and two tools
configured identically share one. The digest ignores the fields a consent round
trip fills in — the access token, the refresh token, the expiry, the redirect
URI — so the key survives a token refresh and a change of deployment.

Name the key yourself when you want several tools to share one credential:

```ts
const handler = ToolAuthHandler.fromToolContext(
  context,
  authScheme,
  authCredential,
  {credentialKey: 'crm_tokens'},
);
```

A `credential_key` or `credentialKey` field carried on the credential or on the
scheme does the same, which is how a tool loaded from a configuration document
names its slot. An explicit option wins over the credential, and the credential
wins over the scheme.

A credential stored by an earlier release, under a key derived from the scheme
type alone, is still found. The handler copies it to the derived key on the
first read and leaves the old entry in place.

## OAuth2 and OpenID Connect

An OAuth2 or OIDC credential with no access token needs the user's consent, so
the handler builds an authorization request and returns `state: 'pending'`. It
validates the credential first, and throws rather than asking for consent that
cannot succeed:

- an `Error` when the scheme is OAuth2 or OIDC and the credential has no
  `oauth2` field;
- an `AuthCredentialMissingError` when `clientId` or `clientSecret` is
  missing.

The `client_credentials` grant is the exception. It authenticates the
application rather than a user, so the handler exchanges it directly instead of
asking a user who has nothing to approve.

Once the client answers, the handler stores what it supplied before exchanging
it. That credential carries the refresh token, which the exchanged one does
not. On a later call, when the access token has expired, the handler refreshes
it and writes the refreshed credential back. The write-back matters for a
provider that issues a new refresh token on every refresh: without it the tool
keeps presenting a refresh token the provider already invalidated.

## Injecting a store or an exchanger

Both are structural interfaces, so any object of the right shape works:

```ts
const handler = new ToolAuthHandler(context, authScheme, authCredential, {
  credentialStore: myStore,
  credentialExchanger: myExchanger,
});
```

An injected store replaces session state entirely; the handler writes nothing
to `context.state`.

## Limitations

- **Experimental.** `ToolAuthHandler` is marked `@experimental` and its API
  may change.
- **Session state is not a secret store.** The default store puts the
  credential wherever the session service keeps state. The key is a digest
  for this reason: a readable key would carry the client secret into the
  store and into anything that logs a key.
- **An exchange failure propagates.** The handler does not swallow it, so the
  tool call fails with the exchanger's error rather than reaching the API
  unauthenticated.
