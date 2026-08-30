# ToolAuthHandler and the OpenAPI tool credential

`ToolAuthHandler` gives an OpenAPI tool the credential it calls its API with.
It reads a credential the tool already obtained, refreshes it when the access
token expired, and asks the client for a new one when there is none.

## Introduction

`RestApiTool` calls a third-party API that declares how it authenticates. Every
call repeats the same work: find the credential this tool obtained earlier,
notice that its access token expired, convert the credential into something an
HTTP request can carry, and pause the run when only the user can supply what is
missing. `ToolAuthHandler` is that work, and `RestApiTool` calls it first on
every invocation.

`state: 'done'` carries the credential to call the API with. `state: 'pending'`
means the handler asked the client for a credential, so the tool returns
without calling the API and the run resumes on a later turn.

## Get started

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

`fromToolContext` needs a `Context` from inside a tool call, because a
credential request is filed under the id of the call that waits for it.

## The credential slot

The handler stores the credential under a key derived from a digest of the
scheme and the credential. Two tools that declare the same scheme type against
different OAuth2 apps therefore get their own slot. The digest ignores the
fields a consent round trip fills in — the access token, the refresh token, the
expiry, the redirect URI — so the key survives a token refresh.

Name the key yourself when several tools should share one credential, either
through `{credentialKey: 'crm_tokens'}` or through a `credential_key` field on
the credential or the scheme. An explicit option wins over the credential, and
the credential wins over the scheme.

A credential stored by an earlier release, under a key derived from the scheme
type alone, is copied to the derived key on the first read.

## OAuth2 and OpenID Connect

An OAuth2 or OIDC credential with no access token needs the user's consent, so
the handler returns `state: 'pending'`. It validates the credential first, and
throws rather than asking for consent that cannot succeed: an `Error` when the
credential has no `oauth2` field, and an `AuthCredentialMissingError` when
`clientId` or `clientSecret` is missing. The `client_credentials` grant is the
exception, because it authenticates the application rather than a user.

The handler stores what the client supplied before exchanging it, because that
credential carries the refresh token and the exchanged one does not. When the
access token later expires, the handler refreshes it and writes the refreshed
credential back. That write-back matters for a provider that issues a new
refresh token on every refresh.

## Limitations

- `ToolAuthHandler` is `@experimental` and its API may change.
- The default store puts the credential wherever the session service keeps
  state. The key is a digest for that reason: a readable key would carry the
  client secret into the store.
- An exchange failure propagates rather than being swallowed.
