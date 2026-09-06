# ConnectionsClient

`ConnectionsClient` reads metadata about a Google Cloud Integration Connectors
connection: its service details, the JSON schema of an entity, and the input and
output schemas of an action. Reach for it when you build a tool over a connector
and need to know what the connector accepts before you call it.

## Introduction

An Integration Connectors connection exposes entities and actions whose shape
the connector decides, not your code. A Jira connection publishes different
entities from a Salesforce one, and the fields of each entity are only known at
runtime. A tool that calls `ExecuteConnection` therefore has to ask the
Connectors API what exists first.

`ConnectionsClient` is that read path. It calls `connectors.googleapis.com`,
waits for the long-running operation each metadata call starts, and returns
plain objects. It never writes and never executes a connector call.

The companion module `connector_spec_builders` turns that metadata into the
OpenAPI document a toolset needs. `getConnectorBaseSpec()` builds the skeleton,
`ENTITY_OPERATIONS` builds one path item per entity operation, and
`getActionOperation()` builds one for an action. No caller inside this package
uses them yet; they are the input to a toolset, which is a separate port.

## Get started

```ts
import {ConnectionsClient} from '@google/adk';

const client = new ConnectionsClient({
  project: process.env['GOOGLE_CLOUD_PROJECT']!,
  location: 'us-central1',
  connection: 'my-connection',
});

const details = await client.getConnectionDetails();
const issues = await client.getEntitySchemaAndOperations('Issues');
const action = await client.getActionSchema('CreateIssue');
```

The client signs every request with Application Default Credentials. Pass
`serviceAccountJson` with the contents of a key file to sign with a service
account instead.

## Building a connector spec

```ts
import {ENTITY_OPERATIONS, getConnectorBaseSpec} from '@google/adk';

const list = ENTITY_OPERATIONS.get('list');
if (list === undefined) {
  throw new Error('the list operation is always registered');
}

const spec = getConnectorBaseSpec();
spec.components.schemas['list_Issues_Request'] = list.request('Issues');
spec.paths['/v2/projects/p/locations/l/integrations/i:execute'] =
  list.operation({
    entity: 'Issues',
    schemaAsString: JSON.stringify(issues.schema),
    toolName: 'issues_tool',
    toolInstructions: 'Use this tool to read issues.',
  });
```

The path item records the connector call on `x-operation`, so a toolset reading
the spec can rebuild the request. Here `post['x-operation']` is
`'LIST_ENTITIES'` and `post.operationId` is `'issues_tool_list_Issues'`.

`getConnectorBaseSpec()` returns a fresh document on every call, so mutating one
spec never affects another.

## Choosing the endpoint

Both hosts follow the standard Google Cloud client variables:

| `GOOGLE_API_USE_MTLS_ENDPOINT` | `GOOGLE_API_USE_CLIENT_CERTIFICATE` | Host                |
| ------------------------------ | ----------------------------------- | ------------------- |
| `always`                       | any                                 | the mutual-TLS host |
| `never`                        | any                                 | the default host    |
| `auto`, unset, or unrecognised | `true`                              | the mutual-TLS host |
| `auto`, unset, or unrecognised | anything else                       | the default host    |

`ConnectionsClient` resolves its host once, in the constructor, so one client
never changes host between calls. `getConnectorBaseSpec()` resolves the
`servers` entry on every call, so a spec built after the environment changes
carries the new host.

Selecting the mutual-TLS host does not present a client certificate. Node has no
counterpart to Python's certificate discovery, so `auto` here trusts
`GOOGLE_API_USE_CLIENT_CERTIFICATE=true` rather than probing for a certificate.
A request to the mutual-TLS host without a certificate is rejected by the
server.

## Failure modes

| Condition                             | What you get                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| HTTP 400 or 404                       | `InputValidationError` naming the project, location and connection                                    |
| Any other non-2xx                     | `Error: Request error: <status> <statusText>`                                                         |
| Credentials do not resolve            | `Error: Credentials error: <message>`                                                                 |
| Credentials yield no token            | `Error: Please provide a service account that has the required permissions to access the connection.` |
| The metadata call starts no operation | `Error: Failed to get entity schema and operations for entity: <entity>`                              |
| An operation never reports `done`     | `Error: Operation <name> did not complete within 120000ms`                                            |

The poll budget is a deliberate difference from adk-python, which polls forever.
A stuck operation would otherwise hang the process.

`ConnectionsClient` is experimental. Its surface can change in a minor release.
