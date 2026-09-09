# GoogleTool

`GoogleTool` wraps a function that calls a Google API. It resolves an OAuth2
credential for the current end user before each call, and hands the credential
to your function. Reach for it when you handcraft a Google API tool and do not
want to write the OAuth handshake yourself.

## Introduction

A tool that reads a user's BigQuery datasets needs that user's consent. The
consent handshake is the same for every Google API: ask the user to authorize,
wait, exchange the response for a token, cache the token, and refresh it when it
expires. `GoogleTool` owns all of that, so your function only makes the API
call.

`GoogleTool` extends `FunctionTool`, so it keeps the schema, the validation and
the confirmation gate you already know. It adds three things:

- A credential arrives as a third argument, next to the model's arguments and
  the tool context. It never enters the schema, so the model can neither see it
  nor supply one.
- A failure comes back as `{status: 'ERROR', error_details}` instead of a thrown
  error, so the model can read it and retry.
- The settings the owning toolset configured arrive on that same argument.

Use `OpenAPIToolset` instead when you have an API spec and want tools generated
from it. `GoogleTool` is for the handcrafted case.

## Get started

```ts
import {BaseGoogleCredentialsConfig, GoogleTool} from '@google/adk';
import {z} from 'zod/v3';

const credentialsConfig = new BaseGoogleCredentialsConfig({
  clientId: process.env.OAUTH_CLIENT_ID,
  clientSecret: process.env.OAUTH_CLIENT_SECRET,
  scopes: ['https://www.googleapis.com/auth/bigquery'],
  tokenCacheKey: 'bigquery_token_cache',
});

const listDatasets = new GoogleTool({
  name: 'list_datasets',
  description: 'Lists the BigQuery datasets in a project.',
  parameters: z.object({projectId: z.string()}),
  credentialsConfig,
  execute: async (input, _toolContext, google) => {
    const headers = await google?.credentials?.getRequestHeaders();
    return fetchDatasets(input.projectId, headers);
  },
});
```

On the first call the user has not authorized yet. The tool emits an auth
request and returns:

```
User authorization is required to access Google services for list_datasets. Please complete the authorization flow.
```

Once the user authorizes, the next call resolves a credential, caches it in
session state, and runs your function.

## Choosing a credential source

`BaseGoogleCredentialsConfig` takes exactly one credential source. Any other
combination throws at construction.

| Source                                        | Use it when                                                      |
| --------------------------------------------- | ---------------------------------------------------------------- |
| `clientId` and `clientSecret` (with `scopes`) | Each end user authorizes their own data.                         |
| `credentials`                                 | One credential serves every end user, such as a service account. |
| `externalAccessTokenKey`                      | Another system already put an access token in session state.     |

A service account or an application-default credential takes a different path:
the manager refreshes it if its token expired, and never starts an OAuth flow.

## Caching a token

Set `tokenCacheKey` to cache the resolved token in session state. The manager
writes it after a refresh and after the OAuth flow completes. Two tools that
share one config also share the cache, so one authorization serves both. Leave
`tokenCacheKey` unset and nothing is cached; every session then starts a new
OAuth flow.

The cached payload is shaped like Google's authorized-user credential file, so
a token adk-js wrote stays readable by the same tooling adk-python targets.

## Handling failures

`GoogleTool.runAsync` never throws. Every failure comes back in band:

```ts
{status: 'ERROR', error_details: "Error in tool 'list_datasets': quota exceeded"}
```

This covers a failure from your function, from argument validation, and from
resolving the credential. One case still propagates: if refreshing a token
fails for a reason other than the token endpoint rejecting the grant, the
manager rethrows, and `GoogleTool` turns that into the same error response.

## Passing settings to your function

`toolSettings` reaches your function as `google.settings`. A toolset uses it to
configure the tools it builds without adding fields the model can see.

```ts
const listDatasets = new GoogleTool({
  name: 'list_datasets',
  description: 'Lists the BigQuery datasets in a project.',
  credentialsConfig,
  toolSettings: {maxQueryResultRows: 50},
  execute: (_input, _toolContext, google) =>
    fetchDatasets(google?.settings?.maxQueryResultRows),
});
```
