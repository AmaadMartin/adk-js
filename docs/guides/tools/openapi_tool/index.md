# Parsing an OpenAPI operation

`OperationParser` reads one OpenAPI operation and reports what a tool needs
from it: the argument list, the JSON schema of those arguments, the function
name, the security scheme, the return type, and the prose that describes the
whole operation. `OpenAPIToolset` runs it for you. Reach for it directly when
you parse an OpenAPI document yourself, or when you want one of those values
without building a tool.

## Introduction

An OpenAPI document describes a schema in more shapes than a tool can use. The
`schema` field may be absent, a boolean (`true` accepts everything, `false`
accepts nothing), a `$ref` pointer, or a plain object. `OpenApiSpecParser`
resolves references before `OperationParser` runs, so by the time an operation
reaches the parser the only remaining pointers are dangling ones.

`normalizeSchema` decides what happens to each shape. A missing schema and
`true` both become an empty schema, because both accept any value. A `false`
schema and a dangling `$ref` throw, because neither describes a value the tool
could send. Failing there is deliberate: the alternative is a tool that
advertises an empty schema and quietly omits a required field.

The rest of the module derives values from a normalized schema.
`createApiParameter` produces the argument record, `getTypeHint` names the
TypeScript type, and `generateParamDoc` / `generateReturnDoc` render the
documentation. `OperationParser` combines them, so most callers only use the
parser.

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

The parser also accepts the JSON text of an operation, which is useful when the
operation arrives over the wire:

```ts
const fromJson = new OperationParser(JSON.stringify(operation));

console.log(fromJson.getFunctionName()); // 'get_pet'
```

Text that parses to something other than an object throws
`Operation must be a JSON object`.

## Security schemes

`getAuthSchemeName()` returns the first scheme of the first security
requirement, and `''` when the operation names none. `OpenApiSpecParser` falls
back to the document-level scheme in that case, so an operation inherits the
document's security unless it names its own.

An operation can list several requirements, which OpenAPI reads as "any one of
these". The parser takes the first, so a spec that offers a cheap scheme and an
expensive one should list the preferred scheme first.

## Reusing parameters you already parsed

`OperationParser.load()` builds a parser over parameters that were parsed
somewhere else. It does not read the operation, so it never throws on a schema
the operation could not resolve, and the supplied parameters are reported
exactly as given.

```ts
import {ApiParameter, OperationParser} from '@google/adk';

const petId: ApiParameter = {
  originalName: 'petId',
  paramLocation: 'path',
  paramSchema: {type: 'integer', description: 'The pet id'},
  description: 'The pet id',
  name: 'pet_id',
  required: true,
};

const loaded = OperationParser.load(operation, [petId]);

console.log(loaded.getParameters().length); // 1
console.log(loaded.getFunctionName()); // 'get_pet'
```

`new OperationParser(operation, {shouldParse: false})` is the same construction
without the parameters: it reads nothing and reports an empty argument list.

## Type names

`getTypeHint` maps a schema onto the type name shown to the model.

| Schema                                     | Type name                 |
| ------------------------------------------ | ------------------------- |
| `{type: 'integer'}`, `{type: 'number'}`    | `number`                  |
| `{type: 'boolean'}`                        | `boolean`                 |
| `{type: 'string'}`                         | `string`                  |
| `{type: 'object'}`                         | `Record<string, unknown>` |
| `{type: 'array', items: {type: 'string'}}` | `string[]`                |
| `{type: 'array'}` with no usable `items`   | `unknown[]`               |
| anything else, or no type                  | `unknown`                 |

A `format` does not change the name: `{type: 'string', format: 'date-time'}` is
still `string`. A type array drops its `'null'` entry, so
`{type: ['string', 'null']}` is `string`; an array naming two other types is
`unknown`.

`getReturnTypeHint()` applies the same map to the response schema the operation
returns, and reports `unknown` when no 2xx response declares one.

## Argument names

`createApiParameter` derives the argument name from the parameter name, in
snake_case. When the spec declares an empty name, or the name snake_cases away
to nothing, the location supplies a default: `body`, `query_param`,
`path_param`, `header_param`, `cookie_param`, and `value` for any other
location. The description falls back to the schema's own description.

```ts
import {createApiParameter} from '@google/adk';

const param = createApiParameter({
  originalName: 'petId',
  paramLocation: 'path',
  paramSchema: {type: 'integer', description: 'The pet id'},
});

console.log(param.name); // 'pet_id'
console.log(param.description); // 'The pet id'
```

## Documenting a return value

`generateReturnDoc` picks the 2xx response that the tool returns: the smallest
numeric status code that carries content. Non-numeric keys such as `default` or
`2XX` sort after the numeric ones, and a response with no content is skipped.
Within that response it prefers `application/json`, and otherwise takes the
first media type. It returns `''` when no 2xx response carries content.

## Failure modes

`normalizeSchema` throws, and every caller propagates the error:

| Input                                | Error                                                                |
| ------------------------------------ | -------------------------------------------------------------------- |
| `false`                              | `<context> uses an unsatisfiable false schema`                       |
| `{$ref: '#/components/schemas/Pet'}` | `<context> contains unresolved reference '#/components/schemas/Pet'` |
| an array                             | `<context> must be an OpenAPI schema, got array`                     |
| a number, a string, or a function    | `<context> must be an OpenAPI schema, got <typeof>`                  |

`<context>` names the site, so the message points at the parameter or the
response that carries the bad schema. `OperationParser` reports
`operation parameter 'petId'`, `request body property 'pet'`, and
`response '200' body`.

One case does not throw: an entry in `operation.parameters` that is itself a
`$ref` is skipped. A single dangling pointer there must not take down every
other tool in the toolset.
