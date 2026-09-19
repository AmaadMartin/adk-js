# BigQueryTool

Wraps a function you write against the BigQuery API and resolves the end user's
Google OAuth credential before it runs. Reach for it when you hand-craft a
BigQuery tool and do not want to write the OAuth handshake as well.

## Introduction

`FunctionTool` runs your function with the arguments the model produced. It
knows nothing about credentials, so a hand-written BigQuery tool has to obtain a
token itself: read the cache, refresh what expired, and ask the end user to
authorize when there is nothing left to refresh. That code is the same in every
BigQuery tool.

`BigQueryTool` is a `FunctionTool` that does it for you. It resolves a
credential for the current end user and passes it to your function as a second
argument. While the end user has yet to authorize, the tool returns a
plain-language message to the model and asks the framework for consent, so the
turn ends without an error. The credential is not part of the declaration the
model sees, so the model cannot supply one.

Use it for tools you write by hand. Tools generated from an API definition go
through `RestApiTool` and the OpenAPI parser instead. The BigQuery API suits a
hand-written tool: its functions overlap, so a model struggles to choose between
them, and many of its parameters are rarely used.

## Get started

Declare the credential source, then the tool. The function receives the
validated arguments and an `OAuth2Client` you can hand to the BigQuery client
library.

```ts
import {BigQueryCredentialsConfig, BigQueryTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

const credentials = new BigQueryCredentialsConfig({
  clientId: process.env.OAUTH_CLIENT_ID,
  clientSecret: process.env.OAUTH_CLIENT_SECRET,
});

const listDatasets = new BigQueryTool({
  name: 'list_datasets',
  description: 'Lists the BigQuery datasets in a project.',
  parameters: z.object({projectId: z.string()}),
  credentials,
  execute: async (input, authClient) => {
    // Query BigQuery with `authClient`, for example through
    // `new BigQuery({projectId: input.projectId, authClient})`.
    return {datasets: [`${input.projectId}:sales`]};
  },
});

const agent = new LlmAgent({
  name: 'bigquery_agent',
  description: 'Answers questions about BigQuery datasets.',
  instruction: 'Use the tools to answer questions about BigQuery.',
  tools: [listDatasets],
});
```

The first turn returns the authorization message and an authorization request.
Once the end user completes the flow, the next turn resolves a credential and
runs your function.

## Naming the tool

`FunctionTool` derives a missing name from the function it is given.
`BigQueryTool` wraps your function, so pass `name` explicitly, or name the
function and pass `name: myFunction.name`. A tool with neither a `name` nor a
named function throws at construction.

## How a credential is resolved

`BigQueryCredentialsManager` tries four sources in order, and stops at the first
that yields a token that has not expired:

1. The credential held by the config, which the manager writes back after every
   successful resolution.
2. The token cached in session state under
   `bigquery_token_cache_<clientId>`.
3. A refresh of the expired token, when it carries a refresh token.
4. The OAuth authorization-code flow, through `Context.requestCredential`.

A refresh that the token endpoint rejects is logged at debug level and falls
through to the flow. Every tool configured with the same client id shares the
cached token, so an end user authorizes once per session. Two tools configured
with different OAuth clients never read each other's grant, because the client
id is part of both the cache key and the key the OAuth response is stored
under.

Only the access token, the refresh token and the expiry reach session state. The
client id and the client secret stay on the config object in memory, because a
session service persists state.

## Configuring the credential source

`BigQueryCredentialsConfig` takes either an authorized `OAuth2Client`, or a
`clientId` and `clientSecret` pair. It throws `InputValidationError` when it gets
neither. An authorized client also supplies the id, the secret and the scopes it
was granted; otherwise `scopes` defaults to
`https://www.googleapis.com/auth/bigquery`.

## Failures

Your function never throws through to the caller. `BigQueryTool` reports a
thrown error to the model as `{status: 'ERROR', error_details: '<message>'}`,
whose field names match the payload adk-python emits.
