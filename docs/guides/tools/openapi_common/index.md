# OpenAPI parameter and documentation helpers

The `openapi_tool` common helpers turn one field of an OpenAPI document into a
tool-facing parameter, and turn a schema into the prose a model reads. Reach for
them when you build tools from an OpenAPI document yourself, instead of letting
`OpenAPIToolset` do it.

## Introduction

An OpenAPI document is user-supplied JSON or YAML. A parameter in it may carry
no usable name, no description, or an unresolved `$ref`, and YAML leaves `null`
wherever a key has no value. Something has to settle each of those before a
parameter can reach a model.

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
`typeof` of the value, never the document itself. Every other function in the
module tolerates a malformed document instead of throwing.

## Get started

```ts
import {
  createApiParameter,
  generateParamDoc,
  generateReturnDoc,
  getTypeHint,
  schemaFromOpenApi,
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

schemaFromOpenApi({$ref: '#/components/schemas/Pet'}, "parameter 'pet' schema");
// Error: parameter 'pet' schema contains unresolved reference
//        '#/components/schemas/Pet'
```

`createApiParameter` calls `schemaFromOpenApi` with the context
`parameter '<originalName>' schema`, so a broken parameter names itself.

## Deriving a name

`createApiParameter` takes the first of these that is not empty:

1. the `name` you pass,
2. the original name in `snake_case`, prefixed with `param_` if it is a
   TypeScript reserved word,
3. a name for the parameter's location — `body`, `query_param`, `path_param`,
   `header_param`, `cookie_param`, or `value` for any other location.

The description falls back the same way: yours, then the schema's own, then an
empty string. `createApiParameter` does not modify the object you pass it.

## Choosing the documented return value

`generateReturnDoc` picks the 2xx response with the lowest numeric status code
that carries content. A response with no content is skipped, and a `$ref`
response entry is ignored. Non-numeric keys such as `default` and `2XX` are
valid, and sort after every numeric one. When no 2xx response has content, the
result is `''`.

Within the chosen response it prefers `application/json`, and otherwise takes
the first content type in the document's order.

## Differences from adk-python

Three things differ from `openapi_tool/common/common.py`:

- `renameReservedWords` guards against TypeScript reserved words, not Python
  ones. `function` is renamed here and not there; `def` is renamed there and not
  here.
- `getTypeHint` emits `number`, `string`, `Record<string, unknown>` and
  `Array<...>` in place of `int`, `float`, `str`, `Dict[str, Any]` and
  `List[...]`. Python's `int`/`float` split collapses into `number`.
- An array of arrays hints `Array<Array<unknown>>`. Python's `get_type_hint`
  gives `List[Any]` there, because `array` is missing from its item map, while
  its `get_type_value` gives `List[List[Any]]`. This follows the second one.

The first two follow from the generated identifiers and type names being
TypeScript. The `param_` prefix, the location default names and the property
indents are identical, because those strings reach the model in the tool schema.
