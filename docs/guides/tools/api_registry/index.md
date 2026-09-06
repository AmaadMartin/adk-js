# ApiRegistry

Lists the MCP servers registered in Google Cloud API Registry for one project,
and returns a toolset for one of them. Reach for it only when your servers are
registered in API Registry; new code should use `AgentRegistry`.

## Introduction

API Registry keeps a per-project catalogue of MCP servers. Each entry has a
resource name and one or more URLs. `ApiRegistry` reads that catalogue once and
hands you an MCP toolset for an entry, so an agent can call the server's tools
without you writing the URL or the credentials into the agent.

`ApiRegistry` is deprecated, in adk-js and in adk-python. It talks to
`cloudapiregistry.googleapis.com`, while `AgentRegistry` talks to the newer
`agentregistry.googleapis.com` and also resolves A2A agents and auth bindings.
This class exists so that code ported from adk-python finds the same class name.

The listing starts in the constructor and every `getToolset` call awaits the same
result, so a registry is listed once however many toolsets you build from it.
A listing failure surfaces at the first `getToolset` call, not at construction:
a TypeScript constructor cannot await.

## Get started

```ts
import {ApiRegistry, LlmAgent} from '@google/adk';

const registry = new ApiRegistry({projectId: 'my-project'});

const toolset = await registry.getToolset(
  'projects/my-project/locations/global/mcpServers/weather',
  {toolNamePrefix: 'weather'},
);

const agent = new LlmAgent({
  name: 'assistant',
  model: 'gemini-2.5-flash',
  tools: [toolset],
});
```

The server name is the `name` field exactly as the registry reports it.
`toolNamePrefix` renames each tool to `${prefix}_${toolName}`, which keeps two
servers that both publish a `search` tool apart. `toolFilter` takes a list of
tool names, or a predicate, and selects which tools the toolset exposes.

`location` defaults to `global`. `headerProvider` supplies extra headers for the
MCP connection; it runs before each connection, so a short-lived value it returns
stays fresh.

## Credentials

Application Default Credentials are resolved for the listing request, and again
for each MCP connection, so a long-running agent keeps working after its first
access token expires.

The credentials are sent to an MCP server only over `https`. A registered URL
that names `http` gets the headers from your `headerProvider` and nothing else,
because a cleartext connection would put a bearer token on the wire in plain
text. A registered URL with no scheme is read as `https`.

## Mutual TLS

Two environment variables decide whether the listing request presents a client
certificate.

| Variable                            | Values                    | Effect                                                                              |
| ----------------------------------- | ------------------------- | ----------------------------------------------------------------------------------- |
| `GOOGLE_API_USE_CLIENT_CERTIFICATE` | `true`                    | Loads the SecureConnect client certificate. Any other value, and unset, loads none. |
| `GOOGLE_API_USE_MTLS_ENDPOINT`      | `always`, `never`, `auto` | Picks the host. Unset or unrecognised means `auto`.                                 |

Under `auto` the mutual-TLS host `cloudapiregistry.mtls.googleapis.com` is used
when a client certificate was loaded, and `cloudapiregistry.googleapis.com`
otherwise. `always` and `never` pick the host outright.

The certificate comes from `~/.secureConnect/context_aware_metadata.json`: ADK
runs the `cert_provider_command` that file names and reads the PEM certificate
and key from its output. A machine without that file needs no configuration —
the listing then connects without a certificate. The certificate stays in
memory, and the provider's output is never logged.

## Failures

| Condition                                                                           | Result                                                                       |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Empty `projectId`                                                                   | The constructor throws `projectId must be provided`.                         |
| The listing request fails, returns a non-2xx status, or returns an unparseable body | `getToolset` rejects with `Error fetching MCP servers from API Registry: …`. |
| Application Default Credentials cannot be resolved                                  | `getToolset` rejects with the credentials error itself.                      |
| No server carries that name                                                         | `getToolset` rejects with `MCP server <name> not found in API Registry.`     |
| The server has no registered URL                                                    | `getToolset` rejects with `MCP server <name> has no URLs.`                   |
