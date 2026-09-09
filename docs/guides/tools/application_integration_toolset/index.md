# ApplicationIntegrationToolset

Turns a Google Cloud Application Integration integration, or an Integration
Connectors connection, into agent tools. Reach for it when the agent must call
an enterprise system — Jira, Salesforce, ServiceNow — that already has a
connector.

## Introduction

Application Integration hosts integrations, and Integration Connectors hosts
connections to third-party systems. Both publish their operations as metadata,
not as an OpenAPI document you can hand to a tool. `ApplicationIntegrationToolset`
reads that metadata, generates the OpenAPI document from it, and builds one tool
per operation.

The toolset has two modes, and the options you pass select the mode.

- **Integration mode**, selected by `integration`. Every API trigger of the
  integration becomes a `RestApiTool`. The toolset delegates to `OpenAPIToolset`.
- **Connection mode**, selected by `connection` plus `entityOperations` or
  `actions`. Every entity operation and every action becomes an
  `IntegrationConnectorTool`. Connection mode needs an `ExecuteConnection`
  integration in the connection's region, or the one named by
  `connectionTemplateOverride`.

`IntegrationConnectorTool` wraps a `RestApiTool`. It adds the connection
identity, and the end user's token, to the arguments the model produced, then
delegates the HTTP call. The model never sees those fields and cannot set them,
so it cannot redirect a call to another connection.

Use `OpenAPIToolset` instead when you already hold an OpenAPI document. This
toolset is for the case where Google Cloud generates that document for you.

## Get started

Set `project` and `location`, name the resource, and pass the toolset to an
agent. The toolset reads the resource metadata on the first `getTools` call, so
the constructor performs no network call.

```ts
import {ApplicationIntegrationToolset, LlmAgent} from '@google/adk';

const jiraTools = new ApplicationIntegrationToolset({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  location: 'us-central1',
  connection: 'my-jira-connection',
  // An empty list for an entity exposes every operation the connector supports.
  entityOperations: {Issues: ['LIST', 'CREATE'], Projects: []},
  actions: ['ExecuteCustomQuery'],
  toolNamePrefix: 'jira',
});

const agent = new LlmAgent({
  name: 'ops',
  model: 'gemini-2.5-flash',
  instruction: 'Answer questions about Jira issues.',
  tools: [jiraTools],
});
```

Integration mode names the integration and its triggers instead:

```ts
import {ApplicationIntegrationToolset} from '@google/adk';

const integrationTools = new ApplicationIntegrationToolset({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  location: 'us-central1',
  integration: 'my-integration',
  triggers: ['api_trigger/my_trigger'],
});
```

## Authentication

The toolset calls Google Cloud with a service identity, and the connector behind
it can call with the end user's identity. The two never share a credential slot.

Pass `serviceAccountJson` to use a service account key. Omit it to use
Application Default Credentials.

```ts
import {ApplicationIntegrationToolset} from '@google/adk';
import {readFileSync} from 'node:fs';

const tools = new ApplicationIntegrationToolset({
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  location: 'us-central1',
  connection: 'my-jira-connection',
  entityOperations: {Issues: []},
  serviceAccountJson: readFileSync(process.env.SERVICE_ACCOUNT_KEY!, 'utf8'),
});
```

A malformed key throws `InputValidationError` from the constructor, so the
failure appears while you assemble the agent.

To let the connector act as the end user, pass `authScheme` and
`authCredential`. The connection must enable `authOverrideEnabled`. When it does
not, the toolset drops both and logs a warning, because the connector rejects a
credential it was not configured to accept.

## Failure modes

- Neither mode configured — `InputValidationError` from the constructor.
- `integration` set with no `triggers` — the constructor succeeds and the first
  `getTools` call throws, because the trigger list is only needed then.
- An unknown entity operation or action — `InputValidationError` from
  `getTools`.
- A network failure during the first `getTools` — the error propagates and the
  toolset forgets the failed attempt, so a later call retries.

Concurrent `getTools` calls share one fetch. `close()` waits for an
initialization already in flight, then releases what it built.
