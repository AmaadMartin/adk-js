# IntegrationConnectorTool

Calls one operation of a Google Cloud Integration Connectors connection.
`IntegrationConnectorTool` wraps a `RestApiTool` built from the generated
connector specification. It fixes the connection the call goes to, adds the end
user's access token, and hides both from the model. Reach for it when an agent
must read or write a connected system such as Jira, Salesforce or BigQuery.

## Introduction

A generated `ExecuteConnection` operation takes the connection identity in its
own request body: `connection_name`, `service_name`, `host`, `entity`,
`operation` and `action`. A plain `RestApiTool` would declare all six to the
model, so the model could send a call to a different connection than the one
you configured. It would also declare `dynamic_auth_config`, the field carrying
the end user's access token.

`IntegrationConnectorTool` removes those seven names from the declaration and
supplies them itself at call time. The model therefore sees only the arguments
of the operation, and it cannot redirect a call.

The tool also frees four arguments the connector defaults: `page_size`,
`page_token`, `filter` and `sortByColumns`. A generated specification marks
them required, but the connector supplies a value for each. They stay in the
declared properties, so the model may still send them, and they leave
`required`, so the model is not forced to invent one.

The connection identity and the token go into a copy of the arguments. The
object you pass to `runAsync` is the one the session records on the
function-call event, so the token never reaches it. For the same reason the
tool logs the argument names only, never their values.

## Get started

Build a `RestApiTool` from the generated operation, wrap it, and hand the
wrapper to an agent.

```ts
import {IntegrationConnectorTool, RestApiTool} from '@google/adk';

const restApiTool = new RestApiTool(
  'list_issues',
  'Lists Jira issues.',
  {
    baseUrl: 'https://integrations.googleapis.com',
    path: '/v2/projects/p/locations/l/integrations/ExecuteConnection:execute',
    method: 'post',
  },
  {
    operationId: 'list_issues',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['connectionName', 'operation', 'pageSize'],
            properties: {
              connectionName: {type: 'string'},
              operation: {type: 'string'},
              pageSize: {type: 'integer'},
              entityId: {type: 'string'},
            },
          },
        },
      },
    },
    responses: {},
  },
);

const tool = new IntegrationConnectorTool({
  name: 'list_issues',
  description: 'Lists Jira issues.',
  connectionName: 'projects/p/locations/l/connections/jira',
  connectionHost: 'jira.example.com',
  connectionServiceName: 'services/jira',
  entity: 'Issues',
  operation: 'LIST_ENTITIES',
  restApiTool,
});

// The model sees `page_size` and `entity_id`, and neither is required.
tool._getDeclaration();
```

## Authenticate the end user

Pass `authScheme` and `authCredential` when the connection accepts an end-user
credential. The tool runs the credential handshake before every call. While the
handshake waits for the user it returns a pending result and calls nothing:

```ts
{pending: true, message: 'Needs your authorization to access your data.'}
```

Once a credential is available the tool sends its token to the connector as
`dynamic_auth_config`:

```ts
{'oauth2_auth_code_flow.access_token': '<the end user access token>'}
```

A credential that carries no token sends an empty object in place of the token
string. The connector reads that as "no end-user token supplied".

`withAuthCredential` returns a copy of the tool that calls with a different
credential, and returns the tool unchanged when it has no `authScheme`. A host
that has exchanged the end-user credential uses it to rebind the token without
rebuilding the tool. The original keeps the raw credential, so a later exchange
starts from it rather than from a token that has since expired.

## Declare a raw JSON schema

By default the tool converts the pruned schema into a genai `Schema` and sets
it as `parameters`. Enable the `JSON_SCHEMA_FOR_FUNC_DECL` feature to send the
JSON schema unchanged as `parametersJsonSchema` instead. Exactly one of the two
is ever set.

```ts
import {FeatureName, overrideFeatureEnabled} from '@google/adk';

overrideFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL, true);
```

The feature is experimental and off by default.

## Read the tool in a log

`toString()` renders the name, the description and the connection identity.
`util.inspect` and a debugger additionally show the connection host, the
service directory and the wrapped tool. Neither renders the credential.

A tool built with `action: 'ExecuteCustomQuery'` and `description: 'Lists
issues.'` renders as:

```
ApplicationIntegrationTool(name="list_issues", description="Lists issues.", connection_name="projects/p/locations/l/connections/jira", entity="Issues", operation="LIST_ENTITIES", action="ExecuteCustomQuery")
```
