# OpenAPI parameter helpers

`ApiParameter` and the helpers around it turn one field of an OpenAPI
specification into the argument a model sees. Reach for them when you parse a
specification yourself, or when you want to know why a generated tool named an
argument the way it did.

## Introduction

`OpenAPIToolset` reads a specification and returns a `RestApiTool` per
operation. Between those two steps every parameter, request-body property and
response passes through `ApiParameter`. The class answers three questions that
the raw specification leaves open.

What is the argument called? A specification may name a parameter `petId`, or
`class`, or nothing at all. The model needs one stable identifier, so
`ApiParameter` derives `name` from `originalName`.

What type is it? OpenAPI describes types in JSON Schema. `getTypeHint` maps a
schema onto a TypeScript type name for a human to read, and `getTypeValue` maps
it onto a structure your code can compare.

Is the schema usable at all? A schema field arrives as an object, a boolean, a
JSON string, or an unresolved `$ref`. `normalizeSchema` accepts the usable
shapes and throws on the rest, so a malformed specification fails while you are
parsing it rather than when the model calls the tool.

You do not need any of this to use `OpenAPIToolset`. It matters when you parse
a specification with `OpenApiSpecParser` and read the parameters yourself.

## Get started

```ts
import {ApiParameter} from '@google/adk';

const param = new ApiParameter({
  originalName: 'petId',
  paramLocation: 'path',
  paramSchema: {type: 'integer', description: 'ID of the pet to fetch'},
  required: true,
});

param.name; // 'pet_id'
param.typeHint; // 'number'
param.typeValue; // {kind: 'integer'}
param.description; // 'ID of the pet to fetch'
String(param); // 'pet_id: number'
param.toDocString(); // 'pet_id (number): ID of the pet to fetch'
```

`paramSchema` also accepts a JSON string, which is how a schema arrives from
some specification loaders:

```ts
const fromJson = new ApiParameter({
  originalName: 'limit',
  paramLocation: 'query',
  paramSchema: '{"type": "integer"}',
});

fromJson.typeHint; // 'number'
```

## How a name is derived

`name` is the first of these that is not empty:

1. The `name` option, when you pass one.
2. `originalName` converted to snake*case, then prefixed with `param*`if the
result is a JavaScript reserved word.`petId`becomes`pet_id`; `class`becomes`param_class`.
3. A default for the location: `body`, `query_param`, `path_param`,
   `header_param` or `cookie_param`.
4. `value`.

`OperationParser` renames a parameter whose name collides with an earlier one
by appending `_1`, `_2` and so on, so `name` is the only mutable field.

## Types

`getTypeHint` returns a name to show a reader; `getTypeValue` returns a value
to branch on.

| Schema                                     | `getTypeHint`               | `getTypeValue`                             |
| ------------------------------------------ | --------------------------- | ------------------------------------------ |
| `{type: 'integer'}`                        | `'number'`                  | `{kind: 'integer'}`                        |
| `{type: 'number'}`                         | `'number'`                  | `{kind: 'number'}`                         |
| `{type: 'string'}`                         | `'string'`                  | `{kind: 'string'}`                         |
| `{type: 'object'}`                         | `'Record<string, unknown>'` | `{kind: 'object'}`                         |
| `{type: 'array', items: {type: 'string'}}` | `'Array<string>'`           | `{kind: 'array', items: {kind: 'string'}}` |
| `{type: ['string', 'null']}`               | `'string'`                  | `{kind: 'string'}`                         |
| `{}`                                       | `'unknown'`                 | `{kind: 'unknown'}`                        |

Two details are worth knowing. `integer` and `number` share the hint `number`,
because TypeScript has one numeric type, but they stay distinct in the type
value. An array of arrays hints `Array<unknown>` while its type value nests, so
read `typeValue` when you care about the element type.

## Documentation strings

`generateParamDoc` renders one argument. `generateReturnDoc` renders what an
operation returns, choosing the smallest numeric 2xx response that carries
content and preferring `application/json` among its media types.

```ts
import {generateReturnDoc} from '@google/adk';

generateReturnDoc({
  '201': {
    description: 'created',
    content: {'application/json': {schema: {type: 'integer'}}},
  },
  '200': {
    description: 'ok',
    content: {'application/json': {schema: {type: 'string'}}},
  },
});
// 'Returns (string): ok'
```

An object schema also lists its properties:

```ts
generateReturnDoc({
  '200': {
    description: 'a pet',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {name: {type: 'string', description: 'The pet name'}},
        },
      },
    },
  },
});
// 'Returns (Record<string, unknown>): a pet Object properties:\n        name (string): The pet name\n'
```

`generateReturnDoc` returns `''` when no 2xx response carries content.

## Errors

`normalizeSchema` throws a plain `Error` naming the value it rejected. The
`ApiParameter` constructor calls it, so a bad schema fails at construction:

```ts
new ApiParameter({
  originalName: 'petId',
  paramLocation: 'path',
  paramSchema: {$ref: '#/components/schemas/Pet'},
});
// Error: parameter 'petId' contains unresolved reference '#/components/schemas/Pet'
```

It rejects an unresolved `$ref`, the `false` schema, a JSON string that does
not parse, and any value that is not an object. A missing schema, `null` and
the `true` schema all yield `{}` instead of throwing, because all three mean
"any value is allowed".

Resolve references before parsing — `OpenApiSpecParser.parse` does this for
you — or the parameters carrying them will throw.
