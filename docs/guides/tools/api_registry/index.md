# ApiRegistry

`ApiRegistry` turns an MCP server registered in the Google Cloud API Registry
into a toolset an agent can use. You give it a project, it lists the registered
servers, and it hands back an `MCPToolset` for the one you name.

**Deprecated.** Use `AgentRegistry` in new code. `ApiRegistry` remains so that
an agent ported from adk-python keeps working.

## Introduction

The Cloud API Registry records the MCP servers a project has registered, each
with a resource name and one or more URLs. Without the registry you would
hardcode a server URL into your agent, and every URL change would be a code
change.

`ApiRegistry` reads the registry instead. It resolves a server name to its URL
at run time, and it authorizes the connection with Application Default
Credentials, so no key material appears in your agent.

It is the older of two registry clients. `AgentRegistry` talks to Agent
Registry, covers A2A agents and endpoints as well as MCP servers, and is the
one to reach for. Choose `ApiRegistry` only when your resources live in the
Cloud API Registry.

The listing is read once per instance and kept in memory. A failed listing is
not cached, so a later call retries.

## Credentials

`ApiRegistry` resolves an access token before each MCP connection, not once
when it builds the toolset. A toolset that an agent builds at startup keeps
working after the first token expires.

Credentials go only to a Google API host reached over TLS. A server registered
with an `http://` URL, or on a host outside `googleapis.com`, gets no
`Authorization` header. A cloud-platform token must not travel in cleartext or
to a third party. Give such a server its own credentials through
`headerProvider`.

## Extra headers

`headerProvider` supplies headers for the MCP server calls. It runs before each
connection, so it may return a value that expires. The registry listing request
does not use it.

```ts
const registry = new ApiRegistry({
  projectId: 'my-project',
  headerProvider: () => ({'x-tenant': process.env['TENANT_ID'] ?? 'default'}),
});
```

What it returns is merged over the credentials `ApiRegistry` resolved, so
returning `Authorization` replaces the token from Application Default
Credentials.

## Get started

```ts
import {ApiRegistry, LlmAgent} from '@google/adk';

const registry = new ApiRegistry({projectId: 'my-project'});

const toolset = await registry.getToolset(
  'projects/my-project/locations/global/mcpServers/bigquery',
);

const agent = new LlmAgent({
  name: 'analyst',
  model: 'gemini-2.0-flash',
  tools: [toolset],
});
```

`location` defaults to `global`. Pass it when your resources live elsewhere:

```ts
const registry = new ApiRegistry({
  projectId: 'my-project',
  location: 'us-central1',
});
```

## Selecting and renaming tools

`getToolset` takes a filter and a prefix. The filter selects which of the
server's tools the agent sees. The prefix is prepended to each tool name, which
keeps two servers that both expose `search` apart.

```ts
const toolset = await registry.getToolset(serverName, {
  toolFilter: ['list_datasets', 'query'],
  toolNamePrefix: 'bq',
});
```

The agent then sees `bq_list_datasets` and `bq_query`. `ApiRegistry` strips the
prefix before it calls the server.

## Mutual TLS

Set `GOOGLE_API_USE_CLIENT_CERTIFICATE=true` to make the listing request
present a SecureConnect client certificate. `ApiRegistry` reads
`~/.secureConnect/context_aware_metadata.json`, runs the certificate provider
it names, and presents the result. The certificate, the key and the passphrase
stay in memory.

A certificate that cannot be loaded is not fatal: `ApiRegistry` logs a warning
and connects without one.

`GOOGLE_API_USE_MTLS_ENDPOINT` selects the host:

| Value                           | Host                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `always`                        | `cloudapiregistry.mtls.googleapis.com`                                          |
| `never`                         | `cloudapiregistry.googleapis.com`                                               |
| `auto`, unset, or anything else | the mutual-TLS host when a certificate is available, otherwise the default host |

The two variables are independent. `never` still presents the certificate; it
only changes which host receives it.

## Failure modes

| Condition                                                                               | Result                                                                                   |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| The listing request fails, returns a non-2xx status, or returns a body that is not JSON | `getToolset` rejects with `Error fetching MCP servers from API Registry: …`              |
| The named server is not registered                                                      | `getToolset` rejects with `MCP server <name> not found in API Registry.`                 |
| The named server has no URL                                                             | `getToolset` rejects with `MCP server <name> has no URLs.`                               |
| Application Default Credentials yield no token                                          | `getToolset` rejects with `Failed to obtain Google Cloud access token for API Registry.` |

A registered URL that carries no scheme is read as `https`. A URL that already
carries `http://` or `https://` is left alone.
