# GoogleApiToolset

Turns a Google API Discovery document into a set of callable tools. Reach for it
when an agent must call a Google API such as Calendar, Gmail or Sheets, instead
of writing one `FunctionTool` per endpoint.

## Introduction

Google publishes a machine-readable description of most of its REST APIs
through the Discovery service. `GoogleApiToolset` fetches that description,
converts it to an OpenAPI 3 document, and builds one tool per operation.

The class sits on top of two pieces you can also use on their own.
`GoogleApiToOpenApiConverter` does the Discovery-to-OpenAPI conversion, and
`OpenAPIToolset` turns the converted document into `RestApiTool` instances. The
toolset adds what those two do not know about: the Google OpenID Connect
endpoints the tools authenticate against, and the credentials each tool runs
under. Every tool it returns is a `GoogleApiTool`, which carries the OAuth2
client or the service account you configured.

Seven subclasses pin one API each, so you do not repeat the api id and version:
`BigQueryToolset`, `CalendarToolset`, `DocsToolset`, `GmailToolset`,
`SheetsToolset`, `SlidesToolset` and `YoutubeToolset`. Use `GoogleApiToolset`
directly for any other API the Discovery service describes.

## Get started

```ts
import {CalendarToolset, LlmAgent} from '@google/adk';

const calendar = new CalendarToolset({
  clientId: process.env.OAUTH_CLIENT_ID,
  clientSecret: process.env.OAUTH_CLIENT_SECRET,
});

const agent = new LlmAgent({
  name: 'scheduler',
  model: 'gemini-2.5-flash',
  tools: [calendar],
});
```

Any Discovery API works through the base class:

```ts
import {GoogleApiToolset} from '@google/adk';

const drive = new GoogleApiToolset({apiName: 'drive', apiVersion: 'v3'});
```

## Tool names

A tool takes its name from the Discovery method id, so the Calendar API's
`events.list` method becomes the tool `calendar.events.list`. `toolNamePrefix`
prepends a prefix and an underscore to every name.

```ts
const calendar = new CalendarToolset({toolNamePrefix: 'gcal'});
// -> gcal_calendar.events.list
```

## Select the operations

`toolFilter` accepts a list of tool names or a predicate. The list matches the
name after `toolNamePrefix` is applied.

```ts
const calendar = new CalendarToolset({
  toolFilter: ['calendar.events.list', 'calendar.calendars.get'],
});

const tools = await calendar.getTools();
```

`setToolFilter` replaces the filter later, including after the first
`getTools()` call.

```ts
calendar.setToolFilter((tool) => tool.name.endsWith('.get'));
```

A predicate receives the `ReadonlyContext` of the current invocation as its
second argument. `getTools()` called outside an invocation passes `undefined`
there, so a predicate that reads the context must handle the absent case.

## Credentials

Pass `clientId` and `clientSecret` to call the API as the user, after the user
grants consent. Pass `serviceAccount` to call it as a service account instead; a
service account wins over a client id pair.

```ts
const sheets = new SheetsToolset({
  serviceAccount: {useDefaultCredential: true},
});
```

`configureAuth(clientId, clientSecret)` and `configureSaAuth(serviceAccount)`
set the credentials after construction. `getTools()` builds its tools fresh on
every call, so the next call returns tools that carry the new credentials.

The tools request the API's first Discovery scope. `additionalScopes` adds more,
in the order you give them:

```ts
const calendar = new CalendarToolset({
  additionalScopes: ['https://www.googleapis.com/auth/drive.readonly'],
});
```

`additionalHeaders` adds headers to every request the tools send. A header the
request already carries is never replaced, so a default header cannot clobber
the `Authorization` header of the exchanged credential.

## Fetching the Discovery document

The fetch happens on the first `getTools()` call, not in the constructor, and
once per instance. Concurrent `getTools()` calls share that one request. A
failed fetch rejects `getTools()` and is not remembered, so a later call tries
again.

`discoveryUrl` replaces the default endpoint. `{api}` and `{apiVersion}` are
substituted, and an `http:` URL works, which is what a private Discovery service
needs.

```ts
const calendar = new CalendarToolset({
  discoveryUrl: 'https://discovery.example/{api}/{apiVersion}.json',
});
```

`close()` releases the toolset. It never fetches anything, so closing a toolset
that was never used costs nothing, and it resolves even after a failed fetch.

## Mutual TLS

Set `GOOGLE_API_USE_CLIENT_CERTIFICATE=true` to present a SecureConnect client
certificate. The toolset then fetches the Discovery document from the API's
mutual-TLS host, points the tools at the document's `mtlsRootUrl`, and presents
the same certificate on every tool request.

```bash
GOOGLE_API_USE_CLIENT_CERTIFICATE=true node ./agent.js
```

The certificate comes from `~/.secureConnect/context_aware_metadata.json`. ADK
runs the provider command that file names, and keeps the certificate, the
private key and the passphrase in memory. A machine with no metadata file gets
no certificate, and the tools connect over ordinary TLS.

The tool requests need `undici`, which is an optional peer dependency. Install
it on the machines that use a client certificate:

```bash
npm install undici
```

`globalThis.fetch` has no per-request client-certificate option, so the
certificate travels on an `undici` `Agent` that ADK attaches to each request as
its dispatcher. That agent owns the key material and the connection pool.
`close()` destroys it, so close the toolset when the agent shuts down.

```ts
const calendar = new CalendarToolset({clientId, clientSecret});
const tools = await calendar.getTools();
// ... run the tools ...
await calendar.close();
```

A `getTools()` call after `close()` fetches the Discovery document again and
builds a new agent that carries the certificate.
