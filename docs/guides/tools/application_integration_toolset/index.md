# ApplicationIntegrationToolset

`ApplicationIntegrationToolset` turns a Google Cloud Application Integration
integration, or an Integration Connectors connection, into agent tools. Reach
for it when your agent must call an enterprise backend that Integration
Connectors already speaks to, such as Jira, Salesforce or ServiceNow.

## Introduction

An agent that needs a record from a business system has two poor options: hand
it a raw HTTP tool and hope the model composes the request correctly, or write
one tool per operation by hand. Integration Connectors already exposes a
uniform schema for every backend it supports. This toolset reads that schema
and generates one typed tool per operation, so the model sees named parameters
instead of a URL.

The toolset works in two modes, and the options you pass select the mode.

**Integration mode** takes an `integration`. The toolset asks the Application
Integration API for the OpenAPI document of that integration, then hands the
document to `OpenAPIToolset`. You get plain `RestApiTool`s, the same kind any
OpenAPI document produces. Pass `triggers` to expose named API triggers only;
omit it to expose every API trigger the integration has.

**Connection mode** takes a `connection` plus `entityOperations`, `actions`, or
both. Here there is no published OpenAPI document, so the toolset reads the
connection metadata and the entity and action schemas, then builds the document
itself. Each generated operation is wrapped in an `IntegrationConnectorTool`,
which injects the connection identity into the request body before the call
goes out. The model never sees those fields.

The distinction matters for auth. In integration mode one identity calls the
integration. In connection mode two do: a service account reaches the
`ExecuteConnection` integration, and an end-user credential can reach the
connector behind it. See [End-user authentication](#end-user-authentication).

## Get started

Both examples need `project` and `location`. Credentials come from Application
Default Credentials unless you pass `serviceAccountJson`.

```ts
import {ApplicationIntegrationToolset, LlmAgent} from '@google/adk';

const jiraToolset = new ApplicationIntegrationToolset({
  project: 'my-project',
  location: 'us-central1',
  connection: 'jira-connection',
  entityOperations: {Issues: [], Projects: ['LIST', 'GET']},
  toolNamePrefix: 'jira',
});

const agent = new LlmAgent({
  name: 'issue_manager',
  model: 'gemini-2.0-flash',
  tools: [jiraToolset],
});
```

An empty array for an entity means every operation the connector reports for
it. `Projects: ['LIST', 'GET']` restricts that entity to two. The supported
operation names are `LIST`, `GET`, `CREATE`, `UPDATE` and `DELETE`, matched
without regard to case; any other name throws when the tools are built.

Integration mode is shorter, and `triggers` is optional:

```ts
const integrationToolset = new ApplicationIntegrationToolset({
  project: 'my-project',
  location: 'us-central1',
  integration: 'my-integration',
  triggers: ['api_trigger/my_trigger'],
});
```

## When the network calls happen

The constructor does no I/O. It validates the options and throws
`InputValidationError` if you gave neither an integration nor a connection with
work to do, or if `serviceAccountJson` does not parse.

Every read runs on the first `getTools()` call, so that is where a network
error surfaces. The result is memoized: a second `getTools()` serves the tools
the first one built, and concurrent callers share one initialization. A failed
attempt is discarded rather than remembered, so a transient error does not
leave the toolset empty for good.

```ts
const toolset = new ApplicationIntegrationToolset({
  project: 'my-project',
  location: 'us-central1',
  connection: 'jira-connection',
  entityOperations: {Issues: []},
});

const tools = await toolset.getTools(); // reads the connector metadata
await toolset.getTools(); // no further network calls
```

## End-user authentication

`authScheme` and `authCredential` let a tool call reach the backend as the end
user instead of the service account. The connection must permit it: the
toolset reads `authOverrideEnabled` from the connection metadata, and drops
both options with a warning when the connection has it off. This mirrors the
server-side check, so an agent cannot force an override the connection forbids.

When an end-user credential is present and allowed, the connector tool places
its token in the `dynamic_auth_config` field of the request body. When the
credential is still being obtained, the tool returns
`{pending: true, message: 'Needs your authorization to access your data.'}`
instead of calling the backend.

## Selecting tools

`toolFilter` accepts a list of tool names or a predicate, and applies in both
modes. A connector tool is named from `toolNamePrefix`, the operation and the
entity, so the example below exposes the list tool and hides the rest.

```ts
const toolset = new ApplicationIntegrationToolset({
  project: 'my-project',
  location: 'us-central1',
  connection: 'jira-connection',
  entityOperations: {Issues: []},
  toolNamePrefix: 'jira',
  toolFilter: ['jira_list__issues'],
});
```

Call `getTools()` once and read the names if you are unsure what a connection
produces.

## Endpoints and limits

The toolset calls `connectors.googleapis.com` and
`{location}-integrations.googleapis.com` over HTTPS. It does not select an
mTLS endpoint; adk-python does, and that gap is tracked separately.

Building a connector tool can start a long-running operation. The toolset polls
it and gives up after a bounded number of attempts rather than waiting forever,
so a stuck operation fails `getTools()` with an error naming it.
