# ApplicationIntegrationToolset

`ApplicationIntegrationToolset` turns a Google Cloud Application Integration
resource into agent tools. Reach for it when your agent must act on a system
that Integration Connectors already reaches — Jira, Salesforce, ServiceNow,
BigQuery — or when your team has an Application Integration flow you want an
agent to trigger.

## Introduction

Application Integration hosts two kinds of resource, and this toolset covers
both.

An **integration** is a flow you built in Application Integration. It exposes
one or more API triggers. The toolset asks the service to generate an OpenAPI
spec for those triggers and hands it to `OpenAPIToolset`, so each trigger
becomes an ordinary `RestApiTool`.

A **connection** is an Integration Connectors connection to a third-party
system. A connection has entities, such as `Issues`, and actions, such as
`ExecuteCustomQuery`. There is no generated spec for these, so the toolset
reads the connection's metadata and assembles a spec itself. Each generated
operation becomes an `IntegrationConnectorTool`: a tool that adds the
connection, entity and operation to every call and delegates the request to a
`RestApiTool`.

The two modes are exclusive. Give `integration`, or give `connection` together
with `entityOperations` or `actions`. Anything else throws from the
constructor.

Connection mode has a prerequisite that is easy to miss. The connector call
runs through an Application Integration integration named `ExecuteConnection`,
with an `api_trigger/ExecuteConnection` trigger, in the same region as the
connection. Create it before you build the toolset, or override its name with
`connectionTemplateOverride`.

## Get started

```ts
import {ApplicationIntegrationToolset, LlmAgent} from '@google/adk';

const jiraTools = new ApplicationIntegrationToolset({
  project: 'my-project',
  location: 'us-central1',
  connection: 'my-jira-connection',
  // An empty list means every operation the connector supports.
  entityOperations: {Issues: ['LIST', 'GET'], Projects: []},
  actions: ['ExecuteCustomQuery'],
});

const agent = new LlmAgent({
  name: 'jira_agent',
  model: 'gemini-2.5-flash',
  tools: [jiraTools],
});
```

For an integration instead of a connection, name the integration and its
triggers:

```ts
const integrationTools = new ApplicationIntegrationToolset({
  project: 'my-project',
  location: 'us-central1',
  integration: 'my-integration',
  triggers: ['api_trigger/my_trigger'],
});
```

## Naming the generated tools

Each generated tool is named after its operation. `toolNamePrefix` is prepended
to that name, which keeps two toolsets in one agent from colliding.
`toolInstructions` is appended to every generated description, which is where
to put guidance the model needs for your data.

```ts
new ApplicationIntegrationToolset({
  project: 'my-project',
  location: 'us-central1',
  connection: 'my-jira-connection',
  entityOperations: {Issues: ['LIST']},
  toolNamePrefix: 'jira',
  toolInstructions: 'Always filter by the current project.',
});
```

Use `toolFilter` to expose a subset. It takes a list of tool names, or a
predicate over the tool and the context.

## Credentials

The toolset needs two identities, and they do different jobs.

The **service identity** reads the integration or connection metadata, and runs
the `ExecuteConnection` integration. It comes from `serviceAccountJson`, the
contents of a service account key file. Omit it to use Application Default
Credentials.

The **end user identity** is optional. A connection with an auth override
accepts a token from the caller and acts as that user in the target system.
Supply `authScheme` and `authCredential` for that.

```ts
new ApplicationIntegrationToolset({
  project: 'my-project',
  location: 'us-central1',
  connection: 'my-jira-connection',
  entityOperations: {Issues: ['LIST']},
  serviceAccountJson: process.env.INTEGRATION_SA_KEY,
  authScheme: {type: 'http', scheme: 'bearer'},
  authCredential: endUserCredential,
});
```

If the connection does not have `authOverrideEnabled`, the toolset drops both
values and logs a warning. The call then runs as the service identity. This
matters: a caller who expects per-user access gets service-account access
instead, so check the warning if rows appear that a user should not see.

## When the network work happens

Reading the resource needs a network call, and a TypeScript constructor cannot
await one. The constructor therefore only validates its options, and the first
`getTools()` call does the reading. The result is memoized, so repeated and
concurrent calls read the resource once. A failed read is not memoized: the
next `getTools()` tries again.

```ts
const toolset = new ApplicationIntegrationToolset({...});
const tools = await toolset.getTools(); // reads the resource
await toolset.getTools();               // returns the same tools
await toolset.close();
```

## Differences from adk-python

`adk-python` reads the resource in its constructor, so its tools exist as soon
as the object does. The behaviour is otherwise the same.

`adk-python` also resolves an exchanged end-user credential at the toolset
level, through `BaseToolset.get_auth_config()`. adk-js has no such hook, so
each tool carries the credential it was built with and `ToolAuthHandler`
exchanges it on every call.
