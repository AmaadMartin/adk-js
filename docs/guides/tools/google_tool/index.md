# GoogleTool

`GoogleTool` is a `FunctionTool` for a handcrafted Google API tool. It resolves
a Google credential before your function runs, injects that credential and your
tool settings into the call, and returns a structured error instead of throwing.
Reach for it when you write a Google API tool by hand, rather than generating
one from an API specification.

## Introduction

A Google API tool needs a credential, and getting one takes several turns. The
end user must grant consent, the client must send the grant back, and the token
must be refreshed once it expires. Writing that into each tool duplicates the
work and gets it subtly wrong.

`GoogleTool` does it once. You give it a `BaseGoogleCredentialsConfig` saying
how to obtain the credential. On a call it resolves one, and it runs your
function only when it has one. When it has none it asks the client for consent
and returns a message saying so, so the invocation pauses instead of failing.

`AuthenticatedFunctionTool` solves the same problem for any OAuth2 provider and
hands your function an ADK `AuthCredential`. `GoogleTool` is the Google-specific
version: it hands your function a `google-auth-library` `AuthClient`, which the
Google API client libraries accept directly.

## Get started

Declare a `credentials` parameter to receive the resolved credential. The model
never sees that parameter and cannot supply it.

```ts
import {BaseGoogleCredentialsConfig, GoogleTool} from '@google/adk';
import type {AuthClient} from 'google-auth-library';
import {z} from 'zod/v3';

const credentialsConfig = new BaseGoogleCredentialsConfig({
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  scopes: ['https://www.googleapis.com/auth/bigquery'],
  tokenCacheKey: 'bigquery_token',
});

export const listDatasets = new GoogleTool({
  name: 'list_datasets',
  description: 'Lists the BigQuery datasets in a project.',
  parameters: z.object({
    projectId: z.string(),
    credentials: z.custom<AuthClient>(),
  }),
  credentialsConfig,
  execute: async ({projectId, credentials}) => {
    const response = await credentials.request({
      url: `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/datasets`,
    });
    return response.data;
  },
});
```

The first call has no cached token. The tool asks the client for consent and
returns:

```
User authorization is required to access Google services for list_datasets. Please complete the authorization flow.
```

The client collects the grant and resumes the invocation. The tool then mints a
credential, caches it under `tokenCacheKey`, and runs `execute`.

## The injected parameters

`GoogleTool` reserves two parameter names.

| Parameter     | What it receives                                   |
| ------------- | -------------------------------------------------- |
| `credentials` | The resolved `AuthClient`.                         |
| `settings`    | The object passed as `toolSettings`, by reference. |

Both are injected only when your `parameters` schema declares them, so a schema
that rejects unknown keys still works. Both are removed from the function
declaration the model reads, and any value the model sends for either is
dropped before your function runs.

Without a `credentialsConfig` the tool runs no credential machinery: it never
asks for consent, and it injects `undefined` for a declared `credentials`
parameter.

Use `toolSettings` for the configuration a toolset shares across the tools it
builds:

```ts
const listDatasetsWithLimit = new GoogleTool({
  name: 'list_datasets',
  description: 'Lists the BigQuery datasets in a project.',
  parameters: z.object({
    projectId: z.string(),
    settings: z.custom<{maxRows: number}>(),
  }),
  toolSettings: {maxRows: 50},
  execute: ({projectId, settings}) =>
    queryDatasets(projectId, settings.maxRows),
});
```

## Credential modes

`BaseGoogleCredentialsConfig` accepts exactly one of three modes. Any other
combination throws `InputValidationError` from the constructor.

1. **An OAuth2 client** (`clientId`, `clientSecret`, `scopes`) drives the end
   user through a consent flow, as above.
2. **A credential you already hold** (`credentials`) is used for every end user.
   Use it for a service account or for application default credentials.
3. **An external access token** (`externalAccessTokenKey`) names a session-state
   key holding a token the host obtained elsewhere.

```ts
const hostSuppliedToken = new BaseGoogleCredentialsConfig({
  externalAccessTokenKey: 'google_access_token',
});
```

Set `tokenCacheKey` to cache the resolved credential in session state. The cache
entry uses the same layout adk-python writes, so a session written by either SDK
is readable by the other. Leave it unset and each invocation resolves a
credential again.

## Errors

`runAsync` never rejects. Every failure — credential resolution, argument
validation, and your function — becomes this value:

```ts
{status: 'ERROR', error_details: "Error in tool 'list_datasets': Dataset not found"}
```

The model receives that as the tool response and can react to it, instead of the
exception ending the turn. The `error_details` key is snake_case because
adk-python emits the same key.

`detectErrorInResponse` reports `'TOOL_ERROR'` for that shape. It is the
telemetry hook adk-python's `_detect_error_in_response` provides. Nothing in
adk-js calls it yet, so call it yourself to classify a tool result.
