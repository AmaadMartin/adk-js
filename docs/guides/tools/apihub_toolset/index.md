# APIHubToolset

`APIHubToolset` turns an API Hub specification into agent tools. It fetches the
specification text through a client you supply, parses it as OpenAPI, and
exposes one tool per operation. Reach for it when your API already lives in API
Hub and you do not want to keep a copy of the specification next to your agent.

## Introduction

`OpenAPIToolset` builds tools from a specification you already hold, as an
object or a string. That is the right tool when the specification ships with
your code. It is the wrong tool when the specification is owned by API Hub,
because you then have to fetch it, decide when to fetch it, and name the toolset
yourself.

`APIHubToolset` adds exactly that layer and delegates the rest to
`OpenAPIToolset`. It owns three things: when the fetch happens, that it happens
only once, and where the toolset's `name` and `description` come from when you
do not set them.

Fetching is a separate concern, so the toolset does not do it. You pass a
`BaseAPIHubClient`, an interface with a single `getSpecContent` method. This
keeps credential handling, retries and transport out of the toolset, and lets a
test supply a fake client without touching the network.

## Get started

```ts
import {APIHubToolset, BaseAPIHubClient, LlmAgent} from '@google/adk';

const apihubClient: BaseAPIHubClient = {
  async getSpecContent(resourceName: string) {
    return fetchMySpecText(resourceName);
  },
};

const toolset = new APIHubToolset({
  apihubResourceName: 'projects/my-project/locations/us-central1/apis/my-api',
  apihubClient,
});

const agent = new LlmAgent({
  name: 'my_agent',
  model: 'gemini-2.0-flash',
  tools: [toolset],
});
```

`getTools()` returns one tool per operation in the specification. A `GET /test`
operation with `operationId: testGet` becomes a tool named `test_get`.

## When the specification is fetched

By default the constructor starts the fetch immediately and `getTools()` awaits
it. Set `lazyLoadSpec: true` to defer the fetch to the first `getTools()` call:

```ts
const toolset = new APIHubToolset({
  apihubResourceName: resourceName,
  apihubClient,
  lazyLoadSpec: true,
});
```

Either way the client is called at most once per toolset. Calling `getTools()`
again reuses the specification already fetched.

## Name and description

Set `name` and `description` yourself, or let the toolset derive them from the
specification's `info` block. The derived name is the snake_cased title, so
`Mock API` becomes `mock_api`. A specification with no title yields `unnamed`,
and a specification with no description yields an empty string.

## Applying auth to every tool

`authScheme` and `authCredential` apply to every tool the toolset produces:

```ts
import {APIHubToolset, AuthCredentialTypes} from '@google/adk';

const toolset = new APIHubToolset({
  apihubResourceName: resourceName,
  apihubClient,
  authScheme: {
    type: 'oauth2',
    flows: {
      authorizationCode: {
        authorizationUrl: 'https://example.com/auth',
        tokenUrl: 'https://example.com/token',
        scopes: {read: 'Read access'},
      },
    },
  },
  authCredential: {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {clientId, clientSecret},
  },
});
```

## Failure modes

An empty specification is not an error. `getTools()` resolves to an empty array,
and the toolset keeps whatever `name` it already had.

A specification that is not valid YAML is an error, and `getTools()` rejects
with the parse failure. The constructor never throws for this: on the eager path
it holds the failure and rethrows it from `getTools()`, so a failed fetch cannot
surface as an unhandled rejection.
