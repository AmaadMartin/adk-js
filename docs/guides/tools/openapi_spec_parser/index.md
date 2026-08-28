# OpenApiSpecParser

Turns an OpenAPI v3 document into one `ParsedOperation` per path and method.
Reach for it when you need the operations of a spec as data. To call the
endpoints instead, use `OpenAPIToolset`, which builds on this parser.

## Introduction

An OpenAPI document is awkward to consume directly. Parameters arrive in three
places (the path item, the operation, and the request body), schemas hide
behind `$ref` pointers, and the security a call needs may be declared globally
or on the operation.

`OpenApiSpecParser` flattens all of that. It resolves every internal `$ref`,
drops schema types that Gemini function calling rejects, merges path-level and
operation-level parameters, and resolves the auth scheme each operation
requires. The result is a flat list of operations that a tool layer can use
without reading the spec again.

`OpenAPIToolset` is the layer above: it calls this parser and wraps each
`ParsedOperation` in a `RestApiTool`. Use the parser directly when you want the
operations for something else, such as generating documentation or filtering a
spec before you build tools.

## Get started

```ts
import {OpenApiSpecParser} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';

const spec: OpenAPIV3.Document = {
  openapi: '3.0.0',
  info: {title: 'Minimal API', version: '1.0.0'},
  servers: [{url: 'https://api.example.com'}],
  paths: {
    '/test': {
      get: {
        operationId: 'testGet',
        responses: {
          '200': {
            description: 'Successful response',
            content: {'application/json': {schema: {type: 'string'}}},
          },
        },
      },
    },
  },
};

const operations = new OpenApiSpecParser().parse(spec);

console.log(operations[0].name); // 'test_get'
console.log(operations[0].endpoint.baseUrl); // 'https://api.example.com'
console.log(operations[0].returnValue.paramSchema.type); // 'string'
```

## What a parsed operation contains

| Field         | What it holds                                             |
| ------------- | --------------------------------------------------------- |
| `name`        | The tool function name, from `operationId`.               |
| `description` | The operation `description`, or its `summary`, or `''`.   |
| `endpoint`    | The base URL, path, and method to call.                   |
| `operation`   | The operation object, with references resolved.           |
| `parameters`  | Path, query, header, and request-body fields as one list. |
| `returnValue` | The response of the lowest 2xx response code.             |
| `authScheme`  | The security scheme the operation requires, if any.       |

`returnValue` is always present. Its `paramSchema` is `{}` when the operation
declares no 2xx response that carries a schema.

## Operation names

`name` comes from `operationId`, converted to snake_case. An operation that
declares no `operationId` gets one built from its path and method:

| Path and method       | Generated name      |
| --------------------- | ------------------- |
| `/test` + `get`       | `test_get`          |
| `/users/{id}` + `get` | `users_id_get`      |
| `/v1/getUsers` + post | `v1_get_users_post` |

adk-python names the same operations the same way, so one spec produces one
set of tool names in both SDKs.

## Order and immutability

The order is stable. Paths keep the order of the document. Methods follow a
fixed order: `get`, `post`, `put`, `delete`, `patch`, `head`, `options`,
`trace`.

`parse` never changes the document you pass in. It works on a copy.

## Authentication

The parser resolves the scheme name against
`components.securitySchemes` and puts the scheme on the operation.

An operation that declares its own `security` overrides the global
requirement. That holds for an empty list too, so an endpoint can opt out:

```ts
const spec: OpenAPIV3.Document = {
  openapi: '3.0.0',
  info: {title: 'Status API', version: '1.0.0'},
  security: [{api_key: []}],
  paths: {
    '/status': {
      get: {
        operationId: 'getStatus',
        security: [], // Public. The global api_key does not apply.
        responses: {'200': {description: 'OK'}},
      },
    },
  },
  components: {
    securitySchemes: {api_key: {type: 'apiKey', in: 'header', name: 'X-Key'}},
  },
};

const [status] = new OpenApiSpecParser().parse(spec);
console.log(status.authScheme); // undefined
```

An empty requirement object (`{}`) anywhere in a security list marks the
authentication as optional. The operation then carries no scheme. A tool that
carries a scheme stops and asks the caller for a credential, so an optional
requirement must not force that. Pass `authScheme` and `authCredential` to
`OpenAPIToolset` when you do want to authenticate such a call.

## Failure modes

`parse` throws in three cases.

| Condition                             | Error                                             |
| ------------------------------------- | ------------------------------------------------- |
| The spec is not an object             | `TypeError: OpenAPI spec must be an object.`      |
| A `$ref` points outside the document  | `Error: External references not supported: <ref>` |
| A server URL placeholder has no value | `Error: Unresolved server URL variable ...`       |

A `null` path item is not an error. The parser skips it.

A circular `$ref` is not an error either. The parser resolves the cycle once
and replaces the repeat with an empty schema, so the result stays finite.
