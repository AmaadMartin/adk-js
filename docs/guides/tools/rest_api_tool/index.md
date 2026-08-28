# RestApiTool

Calls one REST endpoint that an OpenAPI operation describes. `OpenAPIToolset`
builds one of these per operation, and you can also build one yourself from an
operation the spec parser already read.

## Introduction

An OpenAPI document describes many operations. `OpenApiSpecParser` reads the
document and returns a `ParsedOperation` for each one: the endpoint, the
operation object, the argument list the model sees, and the security scheme.
`RestApiTool` is what turns one of those into a call. It fills the path
template, sorts the arguments into the path, the query string, the headers and
the body, attaches the credential, and issues the request.

Reach for `createRestApiTool` when you hold a `ParsedOperation` and want one
tool from it. Reach for `OpenAPIToolset` when you want every operation in a
document. The toolset is the common case; the single-tool path matters when you
filter, rename or cache operations yourself, because the parsed operation
travels as plain data and `createRestApiToolFromJson` rebuilds the tool from
JSON.

The tool reports the parameters the parser produced rather than deriving them
again. That is what keeps a renamed or de-duplicated argument name stable: the
name the model was shown is the name the tool answers to.

## Get started

Parse a document, then build a tool from one operation.

```ts
import {OpenApiSpecParser, createRestApiTool} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';

const spec: OpenAPIV3.Document = {
  openapi: '3.0.3',
  info: {title: 'Notes API', version: '1.0.0'},
  servers: [{url: 'https://api.example.com'}],
  paths: {
    '/v1/notes/{noteId}': {
      get: {
        operationId: 'getNote',
        parameters: [
          {
            name: 'noteId',
            in: 'path',
            required: true,
            schema: {type: 'string'},
          },
          {name: 'view', in: 'query', schema: {type: 'string'}},
        ],
        responses: {'200': {description: 'ok'}},
      },
    },
  },
};

const [parsed] = new OpenApiSpecParser().parse(spec);
const tool = createRestApiTool(parsed);

// The runner supplies toolContext when the model calls the tool. Called
// directly, it issues GET https://api.example.com/v1/notes/42?view=full.
const result = await tool.runAsync({
  args: {note_id: '42', view: 'full'},
  toolContext,
});
```

The argument names are the parsed ones. `noteId` becomes `note_id`, because the
parser converts a property name to snake case unless you pass
`preservePropertyNames`.

## Rebuild a tool from JSON

A `ParsedOperation` is plain data, so you can store it and build the tool later.

```ts
import {createRestApiToolFromJson} from '@google/adk';

const stored = JSON.stringify(parsed);
const tool = createRestApiToolFromJson(stored);
```

## What the tool returns

`runAsync` resolves in every case; it does not reject when the endpoint answers
with an error status.

| Response                        | Return value                                       |
| ------------------------------- | -------------------------------------------------- |
| The tool needs authorization    | `{pending: true, message: '...'}`                  |
| 2xx with a JSON content type    | The parsed body                                    |
| 2xx with any other content type | `{text: '<body>'}`                                 |
| Any other status                | `{error: 'Tool <name> execution failed. ...'}`     |
| `fetch` rejects                 | `{error: 'Failed to execute API call: <message>'}` |

A non-2xx response never reaches the model as a parsed body. The tool returns
an error string that names the status code, quotes the body, and tells the
model to retry at most three times. Without it a model reads a `500` error page
as the answer it asked for.

## The request the tool builds

- Every request carries `User-Agent: google-adk/<version> (tool: <name>)`. A
  `header` parameter of the same name replaces it.
- A query parameter whose value is `null` or `undefined` is left out. A model
  that has nothing to say for an optional parameter sends `null`, and
  `?cursor=null` is a value the server reads. `false`, `0` and `''` are sent.
- `cookie` parameters travel in one `Cookie` header, joined with `; `.
- A trailing slash on the server URL is removed once, so it does not double the
  slash the path starts with.
- A fragment in the path template is removed, and a query string in it is
  merged into the query parameters. A parameter the operation declares wins.
- A required parameter the model left out is filled from its `schema.default`.

## Headers you add yourself

`setDefaultHeaders` sets headers for requests that do not already carry them.
It never replaces a header the operation, the credential or the header provider
set, and the comparison ignores case.

```ts
tool.setDefaultHeaders({'X-Tenant': 'acme'});
```

## Choosing the transport

`fetch` has no certificate-verification or timeout option, so `fetchFn` is
where a caller reaches those settings. It receives the request the tool built
and returns the response.

```ts
import {OpenAPIToolset} from '@google/adk';

const toolset = new OpenAPIToolset({
  specStr,
  specType: 'yaml',
  fetchFn: (input, init) =>
    fetch(input, {...init, signal: AbortSignal.timeout(5_000)}),
});
```

A caller behind a proxy that intercepts TLS wraps a fetch bound to a Node
dispatcher that trusts the proxy's certificate authority, in the same place.
`OpenAPIToolset` gives the function to every tool it builds, and a single tool
takes it as `fetchFn` too.

## The name the model sees

Gemini rejects a function name of 64 characters or more, so `RestApiTool` cuts
a longer name to 60 characters. `OpenAPIToolset` prefixes the name it derives
from the operation id, so a long prefix and a long operation id together can
reach that limit.

## Authentication

Pass the scheme and the credential through the parsed operation, or set them on
the tool.

```ts
tool.configureAuthScheme(scheme);
tool.configureAuthCredential(credential);
```

`configureAuthCredential()` with no argument clears the credential the tool
holds, so the next call goes out unauthenticated.

`toString()` renders the name, the description and the endpoint. It never
renders the credential, so it is safe in a log line.
