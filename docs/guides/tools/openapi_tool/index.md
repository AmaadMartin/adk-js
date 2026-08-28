# OpenAPI tool helpers

The OpenAPI tool helpers turn the schema-bearing parts of an OpenAPI operation
into values a tool can use: a concrete schema, a derived argument record, a
TypeScript type name, and the prose a model reads. `OpenAPIToolset` applies them
for you. Reach for them directly when you parse an OpenAPI document yourself, or
when you want the documentation string of an operation.

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

The rest of the helpers are pure derivations on top of a normalized schema.
`createApiParameter` produces the argument record, `getTypeHint` names the
TypeScript type, and `generateParamDoc` / `generateReturnDoc` render the
documentation. `OperationParser.getDocString()` combines the last two into one
string for a whole operation.

## Get started

```ts
import {OperationParser} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';

const operation: OpenAPIV3.OperationObject = {
  operationId: 'getPet',
  summary: 'Get a pet by id',
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

console.log(new OperationParser(operation).getDocString());
```

That prints:

```
Get a pet by id

Args:
    pet_id (number): The pet id

Returns (string): The pet name
```

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

## Failure modes

`normalizeSchema` throws, and every caller propagates the error:

| Input                                             | Error                                                                |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| `false`                                           | `<context> uses an unsatisfiable false schema`                       |
| `{$ref: '#/components/schemas/Pet'}`              | `<context> contains unresolved reference '#/components/schemas/Pet'` |
| a string that is not JSON                         | `<context> must be an OpenAPI schema, got invalid JSON`              |
| a number, an array, or JSON that is not an object | `<context> must be an OpenAPI schema, got <kind>`                    |

`<context>` names the site, so the message points at the parameter or the
response that carries the bad schema. `OperationParser` reports
`operation parameter 'petId'`, `request body property 'pet'`, and
`response '200' body`.

One case does not throw: an entry in `operation.parameters` that is itself a
`$ref` is skipped. A single dangling pointer there must not take down every
other tool in the toolset.
