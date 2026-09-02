# GoogleApiToolset

Turns a Google API Discovery document into a set of authenticated tools. Reach
for it when an agent must call a Google API such as Calendar, Gmail, Docs,
Sheets or YouTube, instead of describing each operation by hand.

## Introduction

Google publishes a Discovery document for each of its APIs. `GoogleApiToolset`
fetches that document, converts it to OpenAPI, and exposes one `GoogleApiTool`
per operation. Each generated tool carries the operation's parameters as its
function declaration, so the model sees typed arguments.

The toolset owns what every operation of one API shares: the OpenID Connect
scheme that points at Google's OAuth2 endpoints, the scopes, the credentials
and any extra headers. It builds that scheme from the Discovery document, using
the document's first declared scope, and applies it to every generated tool.

Three neighbouring pieces do the individual steps, and the toolset assembles
them: `GoogleApiToOpenApiConverter` fetches and converts the document,
`OpenAPIToolset` generates a `RestApiTool` per operation, and `GoogleApiTool`
attaches the credentials to one such tool. Use those directly when you already
hold an OpenAPI document, or when one operation needs different credentials
from the rest.

## Get started

```ts
import {GoogleApiToolset, LlmAgent} from '@google/adk';

const calendar = new GoogleApiToolset({
  apiName: 'calendar',
  apiVersion: 'v3',
  clientId: process.env.OAUTH_CLIENT_ID,
  clientSecret: process.env.OAUTH_CLIENT_SECRET,
});

const agent = new LlmAgent({
  name: 'scheduling_agent',
  model: 'gemini-2.5-flash',
  tools: [calendar],
});
```

`apiName` and `apiVersion` name the Discovery API, so `calendar` and `v3` read
the document at
`https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest`. Set
`discoveryUrl` to read a different one; `{api}` and `{apiVersion}` in it are
substituted.

A TypeScript constructor cannot await, so the constructor starts the fetch and
the first `getTools()` call waits for it. A fetch that fails rejects that call,
and the next call fetches the document again.

## Select the tools

`toolFilter` accepts a list of tool names or a predicate, and `setToolFilter`
replaces it after construction. The next `getTools()` call applies the new
filter; tools it already returned keep the filter they were built under.

```ts
const calendar = new GoogleApiToolset({
  apiName: 'calendar',
  apiVersion: 'v3',
  toolFilter: ['calendar_events_list', 'calendar_events_insert'],
});
```

A tool name is the snake_case form of the Discovery operation id, so
`calendar.events.list` becomes `calendar_events_list`.

`toolNamePrefix` prepends a prefix and an underscore to that name. A name list
matches the name the toolset exposes, so it must include the prefix:
`toolNamePrefix: 'gcal'` turns the two names above into
`gcal_calendar_events_list` and `gcal_calendar_events_insert`. adk-python
matches the unprefixed name here. adk-js matches the exposed one, which is what
`OpenAPIToolset` and `MCPToolset` already do.

A tool the filter rejects is never given the toolset's credentials, so it
cannot call the API even if a caller holds a reference to it.

## Scopes

The toolset requests the first scope the Discovery document declares.
`additionalScopes` adds more, in order, and a duplicate of the first scope is
dropped.

```ts
const calendar = new GoogleApiToolset({
  apiName: 'calendar',
  apiVersion: 'v3',
  additionalScopes: ['https://www.googleapis.com/auth/drive'],
});
```

A document that declares no OAuth2 block has no first scope. The toolset then
requests only `additionalScopes`, and requests nothing when there are none.

## Credentials

Pass `clientId` and `clientSecret` for the user consent flow, or
`serviceAccount` to call the API as a service account. A service account wins
over the client pair. `configureAuth` and `configureSaAuth` set them after
construction, and the next `getTools()` call builds its tools with them.

`additionalHeaders` reaches every request the generated tools send, which is
how an API that demands its own header is served:

```ts
const ads = new GoogleApiToolset({
  apiName: 'googleads',
  apiVersion: 'v21',
  serviceAccount: {useDefaultCredential: true, scopes: [adwordsScope]},
  additionalHeaders: {'developer-token': developerToken},
  additionalScopes: [adwordsScope],
});
```

## Mutual TLS

Set `GOOGLE_API_USE_CLIENT_CERTIFICATE=true` to present the SecureConnect
client certificate. The toolset then reads the Discovery document from
`www.mtls.googleapis.com` and sends every tool request with the certificate.
That path needs the optional peer dependency `undici`; install it with
`npm install undici`.

A machine with no certificate is not an error: the toolset logs a warning and
connects without one.

## Shutting down

`close()` closes the inner `OpenAPIToolset`. A runner that owns the toolset
calls it at the end of the agent server's lifecycle.
