# OperationParser

Turns one OpenAPI operation into the tool signature a model sees: the argument
names, the argument schema, the required list, and the documentation. Reach for
it when you build a tool from an OpenAPI document yourself, or when you need to
predict the argument names `OpenAPIToolset` will generate.

## Introduction

`OpenAPIToolset` reads a whole OpenAPI document and returns one `RestApiTool`
per operation. `OperationParser` is the step in the middle. It reads a single
`OperationObject` and answers four questions the model layer needs: what the
tool is called, what arguments it takes, which of them are required, and what
the operation gives back.

The argument names are the part worth understanding, because an OpenAPI
parameter name is not a valid argument name. A header called `X-Trace-Id`
becomes `x_trace_id`, a query parameter called `class` becomes `param_class`,
and two parameters that collapse onto one name become `name` and `name_0`.
`RestApiTool` keeps the original name alongside, so it can put the value back
where the API expects it. adk-python derives the same names from the same
document, so one OpenAPI file produces one tool signature in both SDKs.

`OperationParser` does not resolve `$ref`. `OpenApiSpecParser` resolves the
whole document first, so a reference that reaches the parser is skipped rather
than followed.

## Get started

```ts
import {OperationParser} from '@google/adk';

const parser = new OperationParser({
  operationId: 'getUserPosts',
  summary: "List a user's posts",
  parameters: [
    {
      name: 'X-Trace-Id',
      in: 'header',
      schema: {type: 'string'},
      description: 'Trace id',
    },
  ],
  responses: {
    '200': {
      description: 'Success',
      content: {'application/json': {schema: {type: 'string'}}},
    },
  },
  security: [{oauth2: ['read']}],
});

parser.getFunctionName(); // 'get_user_posts'
parser.getParameters()[0].name; // 'x_trace_id'
parser.getJsonSchema().required; // []
parser.getReturnTypeHint(); // 'string'
parser.getAuthSchemeName(); // 'oauth2'
```

The constructor also accepts the JSON form of an operation:

```ts
const fromJson = new OperationParser(
  '{"operationId": "get_thing", "responses": {}}',
);
```

A string that does not hold a JSON object raises
`Error('Operation must be a JSON object')`. Malformed JSON raises the
`SyntaxError` that `JSON.parse` throws.

## How an argument gets its name

The parser applies these steps in order, and stops at the first one that
produces a name.

1. With `preservePropertyNames: true`, the original name is kept as it is.
2. Otherwise the original name is converted to snake_case. Punctuation, spaces
   and acronyms are handled, so `X-Trace-Id` gives `x_trace_id` and
   `HTTPResponse` gives `http_response`.
3. A Python reserved word is prefixed with `param_`, in either branch. The list
   is Python's because these names travel on the wire, and both SDKs must
   produce the same one.
4. A name that yields nothing falls back to the parameter location: `body`,
   `query_param`, `path_param`, `header_param`, `cookie_param`, or `value`.

Duplicate names are then numbered from zero, so three parameters called `test`
become `test`, `test_0` and `test_1`.

`getFunctionName()` always returns snake_case and is cut to 60 characters.
`preservePropertyNames` governs argument names only, never the tool name.

## How a request body becomes arguments

The parser reads the first media type of the request body.

| Body schema                           | Arguments                  |
| ------------------------------------- | -------------------------- |
| `object` with properties              | one argument per property  |
| `object` with no properties           | none                       |
| `array`                               | one argument named `array` |
| `oneOf`, `anyOf`, `allOf`, or no type | one argument named `body`  |
| a scalar type                         | one argument named `body`  |

A body property is required only when the schema's `required` list names it.
The single argument a non-object body produces is always optional.

## Documentation and the return value

`getDocString()` renders the summary, one line per argument, and one line for
what the operation returns. An object schema also lists its properties.

```ts
parser.getDocString();
// List a user's posts
//
// Args:
//     x_trace_id (string): Trace id
//
// Returns (string): Success
```

The return value comes from the 2xx response with the smallest status code that
carries content. `getReturnValue()` gives the parsed parameter,
`getReturnTypeHint()` gives a TypeScript type name such as `string` or
`Array<Record<string, unknown>>`, and `getReturnTypeValue()` gives the Gemini
`Type` the model layer consumes. An operation with no 2xx response reports
`unknown` and `Type.TYPE_UNSPECIFIED`.
