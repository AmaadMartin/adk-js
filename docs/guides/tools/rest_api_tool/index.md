# RestApiTool

Turns one operation of an OpenAPI specification into a tool a model can call.
Reach for it when an agent must call an existing HTTP API and you already have
a specification, or a hand-written description of a single endpoint.

## Introduction

`RestApiTool` holds an endpoint, an OpenAPI operation, and the credentials the
operation needs. It derives the function declaration the model sees from the
operation, maps the arguments the model returns onto the path, the query
string, the headers and the body, applies the credential, and parses the
answer.

Most users never construct one. `OpenAPIToolset` parses a whole specification
and builds one `RestApiTool` per operation, which is the path to take when you
have a specification. Construct the tool directly when you have a single
endpoint, or when you keep a tool's configuration outside the code: the
constructor and the setters also accept JSON text.

The tool returns a value rather than throwing. A transport failure becomes
`{error: '...'}`, so a model can read the failure and retry. Call
`detectErrorInResponse()` on that value to classify it for telemetry.

## Get started

```ts
import {AuthCredentialTypes, RestApiTool} from '@google/adk';

const tool = new RestApiTool(
  'get_status',
  'Gets the status of a service.',
  {baseUrl: 'https://api.example.com', path: '/status', method: 'GET'},
  {operationId: 'get_status', responses: {}},
);

tool.configureAuthScheme({type: 'apiKey', name: 'X-API-Key', in: 'header'});
tool.configureAuthCredential({
  authType: AuthCredentialTypes.API_KEY,
  apiKey: process.env.EXAMPLE_API_KEY,
});
```

Give the tool to an agent, and the model calls it by the name you passed.

## Configuration supplied as JSON

The endpoint, the operation, the auth scheme and the credential each accept
JSON text as well as an object, so a tool stored as configuration can be
rebuilt without hand-parsing it.

```ts
const tool = new RestApiTool(
  'get_status',
  'Gets the status of a service.',
  '{"baseUrl":"https://api.example.com","path":"/status","method":"GET"}',
  '{"operationId":"get_status","responses":{}}',
);

tool.configureAuthScheme('{"type":"apiKey","name":"X-API-Key","in":"header"}');
```

Each input is validated. An endpoint without a `path`, an operation that is not
an object, a credential without an `authType`, and a security scheme whose
`type` is missing or unsupported all throw. Malformed JSON raises
`JSON.parse`'s own `SyntaxError`.

The JSON uses the camelCase field names the TypeScript types declare —
`baseUrl`, `authType` — not the snake_case names `adk-python` accepts.

## Response parsing

The tool reads the response body once and tries to parse it as JSON,
whatever the `Content-Type` header says. An API that answers a JSON payload
under `text/plain` therefore reaches the model as an object. A body that does
not parse is returned as `{text: <body>}`, and an empty body as `{text: ''}`.

## The function declaration

By default the tool converts the operation's JSON schema into a Gemini
`Schema` and puts it in `parameters`. Enable the experimental
`JSON_SCHEMA_FOR_FUNC_DECL` feature to send the raw JSON schema in
`parametersJsonSchema` instead, which is lossless for schemas the Gemini
`Schema` type cannot express.

```ts
import {FeatureName, overrideFeatureEnabled} from '@google/adk';

overrideFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL, true);
```

The environment variable `ADK_ENABLE_JSON_SCHEMA_FOR_FUNC_DECL=true` enables it
without a code change. Exactly one of `parameters` and `parametersJsonSchema`
is ever set.

## Rendering a tool

`toRepr()` renders the name, the description, the endpoint, the operation and
the auth scheme. It never renders the credential, so the output is safe to log.
