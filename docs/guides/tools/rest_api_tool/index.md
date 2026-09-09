# RestApiTool

Calls one REST endpoint on behalf of a model. `RestApiTool` turns a single
OpenAPI operation into a tool: it declares the operation's arguments to the
model, applies a credential, sends the request, and returns the parsed body.
Reach for it when you want one endpoint, and for `OpenAPIToolset` when you want
a whole specification.

## Introduction

An OpenAPI operation and a Gemini function declaration describe the same thing
in two shapes. `RestApiTool` holds the operation and produces the declaration
from it, so the model sees the endpoint's real parameters instead of a hand-
written schema. `OpenAPIToolset` parses a whole specification and builds one
`RestApiTool` per operation, so most users never construct one directly.

Construct one directly when the operation does not come from a specification
you can hand to the toolset. A configuration store, an environment variable or
a message payload gives you the endpoint and the operation as JSON text, so
every constructor argument also accepts its JSON text. The tool parses and
validates that text, which keeps the check in one place instead of at every
call site.

A security scheme is validated the same way. `configureAuthScheme` accepts a
typed scheme, an untyped object or JSON text, and always checks the `type`
discriminator and the fields that type requires. A malformed scheme therefore
fails when you configure the tool, not later as a request that quietly carries
no credential.

## Get started

The smallest working tool. `_getDeclaration` is what the model sees, and
`runAsync` is what a tool call runs.

```ts
import {AuthCredentialTypes, RestApiTool} from '@google/adk';

const tool = new RestApiTool(
  'list_pets',
  'List the pets in the store.',
  {baseUrl: 'https://example.com', path: '/pets', method: 'GET'},
  {
    operationId: 'listPets',
    parameters: [
      {
        name: 'limit',
        in: 'query',
        required: true,
        description: 'How many pets to return.',
        schema: {type: 'integer'},
      },
    ],
    responses: {},
  },
  {type: 'apiKey', name: 'X-API-Key', in: 'header'},
  {authType: AuthCredentialTypes.API_KEY, apiKey: process.env.PETS_API_KEY},
);

// { name: 'list_pets', description: ..., parameters: { type: 'OBJECT', ... } }
tool._getDeclaration();
```

## Configure from JSON text

Every constructor argument accepts either the parsed object or its JSON text,
so a caller that reads its configuration from a store does not parse it first.

```ts
import {RestApiTool} from '@google/adk';

const tool = new RestApiTool(
  'list_pets',
  'List the pets in the store.',
  JSON.stringify({
    baseUrl: 'https://example.com',
    path: '/pets',
    method: 'GET',
  }),
  JSON.stringify({operationId: 'listPets', responses: {}}),
  JSON.stringify({type: 'apiKey', name: 'X-API-Key', in: 'header'}),
  JSON.stringify({authType: 'apiKey', apiKey: process.env.PETS_API_KEY}),
);
```

Each string form is validated. An endpoint must carry a string `baseUrl`,
`path` and `method`. An operation must be an object carrying an object
`responses`. A credential must name an `authType` that is an
`AuthCredentialTypes` member. Anything else throws an `Error` naming the field.

`configureAuthScheme` and `configureAuthCredential` accept the same two forms
after construction. Calling `configureAuthCredential()` with no argument clears
the credential.

```ts
tool.configureAuthScheme({type: 'apiKey', name: 'X-API-Key', in: 'header'});
tool.configureAuthCredential(JSON.stringify({authType: 'apiKey', apiKey: key}));
tool.configureAuthCredential(); // clears it again
```

An invalid scheme throws. `dictToAuthScheme` performs the check and is exported
if you want to validate a scheme before you install it.

```ts
tool.configureAuthScheme({in: 'header'});
// Error: Missing 'type' field in security scheme dictionary.

tool.configureAuthScheme({type: 'apiKey', name: 'X-API-Key', in: 'body'});
// Error: Invalid security scheme data: 'in' must be one of query, header, cookie.
```

## Choose the declaration shape

By default the tool converts the operation's JSON Schema to a Gemini `Schema`
and puts it in `FunctionDeclaration.parameters`. Enable the
`JSON_SCHEMA_FOR_FUNC_DECL` feature and it puts the raw JSON Schema in
`FunctionDeclaration.parametersJsonSchema` instead, leaving `parameters` unset.
Use the raw form with a model that reads JSON Schema directly.

The tool reads the feature on every call, so you can turn it on for one call.

```ts
import {FeatureName, withTemporaryFeatureOverride} from '@google/adk';

const declaration = await withTemporaryFeatureOverride(
  FeatureName.JSON_SCHEMA_FOR_FUNC_DECL,
  true,
  () => tool._getDeclaration(),
);
// declaration.parametersJsonSchema is the raw JSON Schema.
```

The feature is registered off. Set `ADK_ENABLE_JSON_SCHEMA_FOR_FUNC_DECL=true`
to turn it on for a whole process.

## Install your own parser

The constructor parses the operation into the tool's argument schema. Pass
`shouldParseOperation: false` when you have already parsed it, then install
your parser.

```ts
import {OperationParser, RestApiTool} from '@google/adk';

const operation = {operationId: 'listPets', responses: {}};

const tool = new RestApiTool(
  'list_pets',
  'List the pets in the store.',
  {baseUrl: 'https://example.com', path: '/pets', method: 'GET'},
  operation,
  undefined,
  undefined,
  {shouldParseOperation: false},
);

tool.setOperationParser(new OperationParser(operation));
```

The tool throws until you install one. `_getDeclaration` and `runAsync` both
report that you must call `setOperationParser()` first.

## Classify a failed call

`runAsync` reports a failure in band: it returns an object carrying an `error`
message rather than throwing, so the model can read it. A caller therefore
cannot tell a failed call from a successful one by its shape alone.
`detectErrorInResponse` makes that decision, which is what telemetry needs.

```ts
const response = await tool.runAsync({args, toolContext});

tool.detectErrorInResponse(response); // 'HTTP_ERROR', or undefined
```

It returns `'HTTP_ERROR'` when the response is an object with a truthy `error`
property, and `undefined` for everything else. It never throws, whatever you
give it.

## Read a tool in a log

`toString()` renders the name, description and endpoint. `util.inspect`,
`console.log` and a debugger additionally show the operation and the security
scheme. Neither rendering includes the credential, so a tool that reaches a log
does not take its secret with it.

```ts
import {inspect} from 'node:util';

String(tool); // RestApiTool(name="list_pets", description="...", endpoint="...")
inspect(tool); // the same, plus operation="..." and authScheme="..."
```
