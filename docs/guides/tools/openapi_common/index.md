# OpenAPI parameter and documentation helpers

The `openapi_tool` common helpers turn one field of an OpenAPI document into a
tool-facing parameter, and turn a schema into the prose a model reads. Reach for
them when you build tools from an OpenAPI document yourself, instead of letting
`OpenAPIToolset` do it.

## Introduction

An OpenAPI document is user-supplied JSON or YAML. A parameter in it may carry
no usable name, no description, an unresolved `$ref`, or a schema held as a
JSON string. Something has to settle each of those before a parameter can reach
a model.

These helpers are that step. `createApiParameter` derives the name and the
description; `schemaFromOpenApi` decides which schema shapes are usable and
rejects the rest; `getTypeHint`, `generateParamDoc` and `generateReturnDoc`
render the TypeScript-flavoured prose that describes a tool to a model.

`OpenAPIToolset` and `OpenApiSpecParser` sit above them and give you finished
`RestApiTool` instances, so use those for the common case. The helpers matter
when you drive the pieces yourself: a hand-built tool from one operation, a
document you preprocess, or your own documentation format over a parsed
operation.

`schemaFromOpenApi` is the validation boundary. It throws an `Error` naming the
offending field rather than returning an empty schema, so a broken document
fails where you can see it. Its message quotes only the `$ref` string and the
`typeof` of the value, never the document itself.

## Get started

Derive a parameter and document it.

```ts
import {
  createApiParameter,
  generateParamDoc,
  generateReturnDoc,
  getTypeHint,
} from '@google/adk';

const param = createApiParameter({
  originalName: 'petId',
  paramLocation: 'path',
  paramSchema: {type: 'integer', description: 'ID of pet to return'},
  required: true,
});

param.name; // 'pet_id'
param.description; // 'ID of pet to return'
getTypeHint(param.paramSchema); // 'number'
generateParamDoc(param); // 'pet_id (number): ID of pet to return'

generateReturnDoc({
  '204': {description: 'No content'},
  '200': {
    description: 'A pet',
    content: {'application/json': {schema: {type: 'object'}}},
  },
}); // 'Returns (Record<string, unknown>): A pet'
```

## Deriving a name

`createApiParameter` takes the first of these that is not empty:

1. the `name` you pass,
2. the snake*case original name, prefixed with `param*` if it is a TypeScript
   reserved word,
3. a name for the parameter's location.

The location names are `body`, `query_param`, `path_param`, `header_param` and
`cookie_param`. Any other location, including an empty one, gives `value`.

```ts
createApiParameter({
  originalName: 'in',
  paramLocation: 'query',
  paramSchema: {type: 'string'},
}).name; // 'param_in'

createApiParameter({
  originalName: '',
  paramLocation: 'body',
  paramSchema: {type: 'string'},
}).name; // 'body'
```

The description falls back the same way: yours, then the schema's own, then an
empty string. `createApiParameter` does not modify the object you pass it.

## Type hints

`getTypeHint` renders TypeScript type names, because the generated surface is
TypeScript.

| Schema                                     | Hint                      |
| ------------------------------------------ | ------------------------- |
| `{type: 'integer'}` or `{type: 'number'}`  | `number`                  |
| `{type: 'boolean'}`                        | `boolean`                 |
| `{type: 'string'}`, with any `format`      | `string`                  |
| `{type: 'object'}`                         | `Record<string, unknown>` |
| `{type: 'array', items: {type: 'string'}}` | `Array<string>`           |
| `{type: 'array'}`                          | `Array<unknown>`          |
| `{type: ['string', 'null']}`               | `string`                  |
| anything else                              | `unknown`                 |

A `type` given as an array is an OpenAPI 3.1 nullable union. `getTypeHint` drops
`'null'` and uses what is left only when one entry remains.

## Rejected schemas

`schemaFromOpenApi(value, context)` accepts `unknown` and returns a schema
object. `undefined`, `null` and `true` all become `{}`, an unconstrained schema.
A JSON string is parsed and then normalized again. A plain object is returned by
reference, unmodified.

Everything else throws, and every message starts with the `context` phrase you
pass:

| Input                     | Message                                             |
| ------------------------- | --------------------------------------------------- |
| `false`                   | `<context> uses an unsatisfiable false schema`      |
| a string that is not JSON | `<context> is not valid JSON`                       |
| `{$ref: '...'}`           | `<context> contains unresolved reference '...'`     |
| an array                  | `<context> must be an OpenAPI schema, got array`    |
| any other non-object      | `<context> must be an OpenAPI schema, got <typeof>` |

```ts
import {schemaFromOpenApi} from '@google/adk';

schemaFromOpenApi({$ref: '#/components/schemas/Pet'}, "parameter 'pet' schema");
// Error: parameter 'pet' schema contains unresolved reference
//        '#/components/schemas/Pet'
```

`createApiParameter` calls it with the context `parameter '<originalName>'
schema`, so a broken parameter names itself.

## Documenting a return value

`generateReturnDoc` picks the 2xx response with the lowest numeric status code
that carries content. A response with no content is skipped, and a `$ref`
response entry is ignored. Non-numeric keys such as `default` and `2XX` are
valid, and sort after every numeric one. When no 2xx response has content, the
result is `''`.

Within the chosen response it prefers `application/json`, and otherwise takes
the first content type in the document's order. An object schema also gets one
line per property.

## Differences from adk-python

Two things differ from `openapi_tool/common/common.py`, both because the
generated identifiers and type names here are TypeScript:

- `renameReservedWords` guards against TypeScript reserved words, not Python
  ones. `function` is renamed here and not there; `def` is renamed there and not
  here.
- `getTypeHint` emits `number`, `string`, `Record<string, unknown>` and
  `Array<...>` in place of `int`, `float`, `str`, `Dict[str, Any]` and
  `List[...]`. Python's `int`/`float` split collapses into `number`.

The `param_` prefix, the location default names and the two property indents are
identical, because those strings reach the model in the tool schema.
