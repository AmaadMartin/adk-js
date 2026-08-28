# Parsing an OpenAPI operation

`OperationParser` reads one OpenAPI operation and reports what a tool needs from
it. `OpenAPIToolset` runs it for you; reach for it directly when you parse an
OpenAPI document yourself. The per-method contract is in the TSDoc — this page
covers the naming and selection rules, which a signature does not show.

## Introduction

Two things make a generated tool wrong in ways that are hard to see. The first
is naming: the argument names the model is shown are derived from the spec, and
a name that is empty, duplicated, or full of punctuation still has to produce a
usable JSON schema key. The second is that an OpenAPI document is looser than a
tool can be — a request body may describe no argument at all, and several 2xx
responses may compete to be the return value.

The parser resolves both, following adk-python so that one spec produces the
same tool in either SDK. This page is the set of rules it applies.

## Get started

```ts
import {OperationParser} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';

const operation: OpenAPIV3.OperationObject = {
  operationId: 'getPet',
  summary: 'Get a pet by id',
  security: [{apiKey: []}],
  parameters: [
    {
      name: 'petId',
      in: 'path',
      description: 'The pet id',
      required: true,
      schema: {type: 'integer'},
    },
  ],
  responses: {
    '200': {
      description: 'The pet name',
      content: {'application/json': {schema: {type: 'string'}}},
    },
  },
};

const parser = new OperationParser(operation);

console.log(parser.getFunctionName()); // 'get_pet'
console.log(parser.getAuthSchemeName()); // 'apiKey'
console.log(parser.getReturnTypeHint()); // 'string'
console.log(parser.getDocString());
```

The last call prints:

```
Get a pet by id

Args:
    pet_id (number): The pet id

Returns (string): The pet name
```

The constructor also accepts the JSON text of an operation.

## Argument names

Names are snake_cased: runs of punctuation and spaces fold to one underscore,
camelCase splits, and acronyms stay whole, so `getHTTPResponse` becomes
`get_http_response` and `REST API` becomes `rest_api`.

A name that derives to nothing takes a default from its location: `body`,
`query_param`, `path_param`, `header_param`, `cookie_param`, or `value`. Two
arguments that snake_case to the same name are numbered from zero: `q`, `q_0`,
`q_1`.

`preservePropertyNames: true` keeps the spec's argument names as they are, for
an API that expects camelCase. It does not change the tool name, which is always
snake_case.

## Request bodies

Only the first media type of a request body is read.

An object body becomes one argument per property, required only when the
schema's `required` list names it. An empty object body produces **no** argument.

Any other body becomes a single argument, and is not required unless the schema
says so:

| Body schema                           | Argument name                     |
| ------------------------------------- | --------------------------------- |
| `array`                               | `array`                           |
| `oneOf`, `anyOf`, `allOf`, or no type | `body`                            |
| a plain scalar                        | `body`, from the location default |

## Return values

`getReturnValue()` and `getDocString()` read the same response: the smallest 2xx
status code that carries content, preferring `application/json` when it offers
several media types. A 2xx response with no content is skipped, so an operation
declaring both `200` without content and `201` with it returns the `201` body.

The return value is named `value` and is never required.

## Optional authentication

An **empty** requirement object means authentication is optional. A tool that
carries a scheme stops and asks the caller for a credential instead of sending
the request, so an optional requirement resolves to no scheme:
`security: [{apiKey: []}, {}]` yields `''`. Pass `authScheme` and
`authCredential` to the toolset when you do want such an operation
authenticated.

`OpenApiSpecParser` reads the document-level `security` through the same rule.
An operation inherits it only when the operation declares no `security` of its
own — `security: []` and `security: [{}]` opt out, and do not fall back.
