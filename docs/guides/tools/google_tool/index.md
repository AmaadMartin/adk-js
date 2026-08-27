# GoogleTool and Google credentials

`GoogleTool` wraps a function that calls a Google API. It resolves a Google
credential before every call and passes the resolved client to the function, so
the function holds no OAuth, refresh or token-caching logic. Reach for it when
you handcraft a tool against a Google Cloud API.

## Introduction

A tool that reads a Spanner database or a BigQuery table needs a Google
credential. Where that credential comes from differs per deployment. A service
running on Google Cloud uses Application Default Credentials. A hosting
application that already signed the user in has an access token to hand over. An
agent acting for an end user has to send that user through an OAuth consent
screen, then keep the resulting refresh token for later turns. Writing all three
into every tool is how the logic drifts apart.

Two classes split the work:

- `BaseGoogleCredentialsConfig` declares where the credential comes from. It
  takes exactly one of three combinations: a pre-built `credentials` client, an
  `externalAccessTokenKey` naming a session-state slot, or a `clientId` and
  `clientSecret` pair for the OAuth flow. It also takes `tokenCacheKey`, the
  session-state key under which a resolved token is cached.
- `GoogleCredentialsManager` turns that declaration into a live `AuthClient` for
  one tool call. It reads the token cache, refreshes an expired token, and
  starts the ADK OAuth flow when the end user has to authorize.

`GoogleTool` owns a manager and does the plumbing. It differs from
`FunctionTool` in two ways: the wrapped function takes a second argument
carrying the credential and the toolset settings, and a failure is returned to
the model as `{status: 'ERROR', error_details}` instead of thrown.

The OAuth flow is the same handshake `AuthConfig` describes elsewhere in ADK.
`GoogleCredentialsManager` builds the `AuthConfig` for you, with Google's
authorization and token endpoints and one entry per configured scope, and calls
`Context.requestCredential`. The tool call ends with a message asking the user
to authorize. On the next turn the manager finds the granted credential in state
and the call proceeds.

## Get started

This tool uses Application Default Credentials, so it needs no consent screen.
Run `gcloud auth application-default login` first.

```ts
import {BaseGoogleCredentialsConfig, GoogleTool} from '@google/adk';
import {GoogleAuth} from 'google-auth-library';
import {z} from 'zod/v4';

const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

const listDatasets = new GoogleTool({
  name: 'list_datasets',
  description: 'Lists the BigQuery datasets in a project.',
  parameters: z.object({projectId: z.string()}),
  credentialsConfig: new BaseGoogleCredentialsConfig({
    credentials: await auth.getClient(),
  }),
  execute: async ({projectId}, {credentials}) => {
    if (!credentials) {
      throw new Error('list_datasets needs a Google credential.');
    }
    const response = await credentials.request({
      url: `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/datasets`,
    });
    return response.data;
  },
});
```

`credentials` is typed optional because a `GoogleTool` may be built without a
credentials config. With one configured the function only runs after a
credential resolves, so the guard never fires; write it anyway rather than
asserting, and TypeScript narrows the rest of the function for you.

## Choosing a credentials configuration

```ts
// 1. A pre-built client: Application Default Credentials, a service account
//    key, or an authorized user. Every end user shares it.
new BaseGoogleCredentialsConfig({credentials: await auth.getClient()});

// 2. An access token the hosting application already obtained and wrote to
//    session state under this key.
new BaseGoogleCredentialsConfig({externalAccessTokenKey: 'access_token'});

// 3. An OAuth client, so each end user authorizes for themselves.
new BaseGoogleCredentialsConfig({
  clientId: process.env.OAUTH_CLIENT_ID,
  clientSecret: process.env.OAUTH_CLIENT_SECRET,
  scopes: ['https://www.googleapis.com/auth/spanner.data'],
  tokenCacheKey: 'spanner_token_cache',
});
```

The constructor throws when the combination is not one of these three. Passing
`credentials` together with `clientId`, or `externalAccessTokenKey` together
with `scopes`, is rejected rather than silently ignored.

A client passed as `credentials` that already carries an OAuth identity lends it
to the config: its client id, client secret and granted scopes are adopted, so a
later re-authorization uses the same OAuth client.

## The token cache

Set `tokenCacheKey` and the manager writes the resolved token to session state
under that key. Leave it unset and the manager never writes to state at all; the
end user then re-authorizes on every turn. Each toolset should use its own key,
so two toolsets with different scopes never share a token.

The cached value is a JSON string in the shape adk-python writes
(`{token, refresh_token, token_uri, client_id, client_secret, scopes, expiry}`,
with `expiry` as an ISO-8601 UTC string). A session written by either SDK is
therefore readable by the other.

## Failure modes

- **The end user has not authorized yet.** The call returns
  `User authorization is required to access Google services for <tool>. Please
complete the authorization flow.` and the wrapped function does not run.
- **The refresh token no longer works.** A token endpoint that rejects the
  refresh sends the user back through the OAuth flow. A refresh that fails for
  another reason, such as a network fault, propagates instead of quietly
  discarding the credential.
- **A credential ADK cannot re-authorize.** A service account or metadata
  credential carries no refresh token. The manager refreshes it best-effort and
  returns it either way, because the calling library may refresh it internally.
- **Anything thrown.** The error propagates like any other tool error, so a
  plugin's `onToolErrorCallback` sees it and the framework reports it to the
  model. `GoogleTool` does not convert it to a payload of its own.

## Toolset settings

A toolset that gives every one of its tools the same configuration captures it
in the closure it already builds.

```ts
const settings = {maxRows: 50};

const query = new GoogleTool({
  name: 'query',
  description: 'Runs a query.',
  execute: (_input, {credentials}) => runQuery(credentials, settings.maxRows),
});
```
