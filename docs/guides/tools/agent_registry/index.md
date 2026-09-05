# AgentRegistry

`AgentRegistry` is the ADK client for the Google Cloud Agent Registry. It turns
a registered MCP server or A2A agent into a ready-to-use ADK component, with
the connection details and the credentials already resolved.

## Introduction

An organisation that runs many agents needs one place that records where each
one lives, what it can do, and who may call it. The Agent Registry service is
that place. Reaching it over plain REST leaves you assembling the pieces
yourself: pick the right connection interface out of the resource metadata,
find the auth provider the resource is bound to, and attach a credential.

`AgentRegistry` does that assembly. `getMcpToolset` returns an
`AgentRegistrySingleMCPToolset` you can hand straight to an agent's `tools`, and
`getRemoteA2AAgent` returns a `RemoteA2AAgent` you can use as a sub-agent. Both
resolve the endpoint URL from the registry, so the calling code names a
resource and nothing else.

Reach for `AgentRegistry` when the servers and agents you depend on are
registered centrally. When you already know an MCP server's URL, construct
`McpToolset` directly instead; the registry adds nothing.

Credentials come from Application Default Credentials, resolved on the first
request rather than in the constructor.

## Get started

List the registered agents, then build a toolset from a registered MCP server.

```ts
import {AgentRegistry, LlmAgent} from '@google/adk';

const registry = new AgentRegistry({
  projectId: 'my-project',
  location: 'global',
});

const {agents} = await registry.listAgents({pageSize: 10});

const toolset = await registry.getMcpToolset(
  'projects/my-project/locations/global/mcpServers/my-server',
);

const agent = new LlmAgent({
  name: 'assistant',
  model: 'gemini-2.5-flash',
  tools: [toolset],
});
```

## Search

`searchAgents` and `searchMcpServers` query the registry by keyword or by
meaning. Both send one POST and accept the same options; every option is
optional, and only the ones you supply reach the request.

```ts
const {agents} = await registry.searchAgents({
  searchString: 'invoice reconciliation',
  searchType: 'SEMANTIC',
  pageSize: 10,
});
```

`searchType` is `'KEYWORD'` or `'SEMANTIC'`. `filterStr`, `orderBy`,
`pageSize` and `pageToken` behave as they do on the list methods.

## Authentication

A registered MCP server can be bound to an auth provider through an IAM
binding. When you do not pass an `authScheme`, `getMcpToolset` reads the
bindings and uses the provider bound to that server. `continueUri` overrides
the redirect the provider declares.

```ts
const toolset = await registry.getMcpToolset('my-server', {
  continueUri: 'https://my-app.example/continue',
});
```

Passing an `authScheme` yourself skips the bindings request entirely. A
bindings lookup that fails, returns nothing, or matches no target leaves the
server unauthenticated and logs a warning; it does not throw.

A registered A2A agent can carry a binding too, and `getRemoteA2AAgent` reads
it the same way. The agent it returns presents `authCredential` as a header on
every request it makes:

```ts
const agent = await registry.getRemoteA2AAgent('my-agent', {
  authCredential: {
    authType: AuthCredentialTypes.HTTP,
    http: {scheme: 'Bearer', credentials: {token: accessToken}},
  },
});

agent.authScheme; // the provider the agent's binding names
```

A credential that still needs an exchange to become a token is not presented,
and neither is an API key whose scheme puts it in the query rather than a
header. An auth provider binding names a provider and carries no credential of
its own, so read `agent.authScheme`, obtain a token for that provider, and pass
it as `authCredential`.

For an MCP server on a `*.googleapis.com` host reached over https, and only
when no auth scheme and no credential apply, the registry attaches its own
Application Default Credentials bearer token. A plaintext `http://` endpoint
never receives that token.

## Mutual TLS

`GOOGLE_API_USE_MTLS_ENDPOINT` chooses the host: `always`, `never` or `auto`.
`auto` is the default, and it picks the mutual-TLS host only when a client
certificate is available. When that host is picked, the registry calls
`agentregistry.mtls.googleapis.com` and rewrites every resolved
`*.googleapis.com` connection URI to its `.mtls.googleapis.com` variant.

A certificate is available when `GOOGLE_API_USE_CLIENT_CERTIFICATE` is `true`
and one of these files exists:

- `~/.secureConnect/context_aware_metadata.json`
- `~/.config/gcloud/certificate_config.json`
- the file `GOOGLE_API_CERTIFICATE_CONFIG` names

Setting `GOOGLE_API_USE_CLIENT_CERTIFICATE=true` on a machine that has no
certificate keeps the registry on the default host. Other Google client
libraries read that variable too, so moving to a host the client cannot reach
would break callers who never asked for mutual TLS.

adk-js does not yet present a client certificate on the connection. Node's
`fetch` has no per-request certificate option, so the mutual-TLS host rejects
the call even when a certificate exists on the machine. Use
`GOOGLE_API_USE_MTLS_ENDPOINT=never` to opt out completely.

## Errors

| Condition                                            | What you get                                                |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| Application Default Credentials cannot be discovered | `Failed to get default Google Cloud credentials: <message>` |
| The token cannot be refreshed                        | `Failed to refresh Google Cloud credentials: <message>`     |
| The service answers non-2xx                          | `API request failed with status <n>: <body>`                |
| The request fails for any other reason               | `API request failed: <message>`                             |
| The MCP server has no endpoint URI                   | `MCP Server endpoint URI not found for: <name>`             |
| The agent has no A2A connection URI                  | `A2A connection URI not found for Agent: <name>`            |
| The bindings lookup fails                            | A warning; the resource stays unauthenticated               |
