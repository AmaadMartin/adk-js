# ApiRegistry

Builds an MCP toolset from a server registered in Google Cloud API Registry.
`ApiRegistry` is deprecated. Reach for it only to run code that already names
it, and prefer `AgentRegistry` for new work.

## Introduction

Cloud API Registry is the older of two Google Cloud registries that list MCP
servers. `ApiRegistry` reads every MCP server the project has registered, then
hands out one toolset per server. You give it a server name; it gives you a
toolset an `LlmAgent` can use, already pointed at the server's registered URL
and already carrying your Application Default Credentials.

`AgentRegistry` supersedes it. That class talks to the Agent Registry service,
which also lists A2A agents and endpoints, resolves authentication providers per
server, and attaches credentials only to Google API hosts. `ApiRegistry` does
none of that, and adk-python marks it deprecated for the same reason. It exists
here so that a port of an agent written against the Python class finds the same
name and the same behaviour.

The listing starts as soon as you construct the class, and it is read once.
A server registered after construction is not visible to that instance.

## Get started

Set up Application Default Credentials, then name the server you want:

```ts
import {ApiRegistry, LlmAgent} from '@google/adk';

const registry = new ApiRegistry({projectId: 'my-project'});

const toolset = await registry.getToolset('my-mcp-server', {
  toolNamePrefix: 'registry_',
});

const agent = new LlmAgent({
  name: 'analyst',
  model: 'gemini-2.5-flash',
  tools: [toolset],
});
```

`location` defaults to `global`. `toolNamePrefix` prepends a prefix to every
tool name, and `toolFilter` narrows the tools the agent sees:

```ts
import {ApiRegistry} from '@google/adk';

const registry = new ApiRegistry({
  projectId: 'my-project',
  location: 'us-central1',
  headerProvider: () => ({'X-Tenant': 'acme'}),
});

const toolset = await registry.getToolset('my-mcp-server', {
  toolFilter: ['list_datasets'],
});
```

`headerProvider` supplies extra headers for the MCP server connection. It runs
on every tool listing, and its headers win over the ones the credentials
produced. It is not called for the registry listing request. It is the way to
authenticate a server that is not a Google API host, because those never
receive your Google Cloud credentials.

## Credentials

`ApiRegistry` resolves Application Default Credentials with the
`https://www.googleapis.com/auth/cloud-platform` scope. It always sends an
`Authorization` header to the registry itself. A quota project on the
credentials is sent as `x-goog-user-project`.

A registered MCP server receives those credentials only when its URL is an
`https` URL on a `googleapis.com` host. A registry entry can name any host, so
any other server gets no access token; it receives only the headers your
`headerProvider` returns. An `http` URL never receives the token, even on a
`googleapis.com` host, because the token would cross the network in plaintext.

Credentials are resolved per connection rather than once, so a long-lived agent
does not hold a stale token.

## Mutual TLS

Two environment variables select the endpoint:

| Variable                            | Values                    | Effect                                                                                                                                                                                  |
| ----------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_API_USE_MTLS_ENDPOINT`      | `auto`, `always`, `never` | `always` forces the mTLS host. `never` forces the ordinary host. `auto` uses the mTLS host only when a client certificate is available. An unset or unrecognised value reads as `auto`. |
| `GOOGLE_API_USE_CLIENT_CERTIFICATE` | `true`, `false`           | Whether to look for a client certificate at all.                                                                                                                                        |

The certificate comes from the SecureConnect contract: the client reads
`~/.secureConnect/context_aware_metadata.json`, runs the `cert_provider_command`
it names, and reads the PEM blocks that command prints. If the file is missing,
the command fails, or the output holds no certificate and key pair, the client
logs a warning and continues without a certificate. It never logs the command's
output, because that output carries the private key.

## Failure modes

The registry listing starts in the constructor, which cannot report a failure
in TypeScript. The failure surfaces from the first `getToolset` call instead.

| Condition                                                                                     | Error                                             |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| The listing request failed, or returned a non-2xx status, or returned a body that is not JSON | `Error fetching MCP servers from API Registry: …` |
| The name is not registered                                                                    | `MCP server <name> not found in API Registry.`    |
| The server is registered with no URL                                                          | `MCP server <name> has no URLs.`                  |
| Credentials could not be resolved                                                             | The underlying credential error, unwrapped        |

A registered URL with no scheme is prefixed with `https://`. One that already
starts `http://` or `https://` is used exactly as registered.

## Checking it against a real project

The automated tests use a local HTTP server, so they never reach Cloud API
Registry. To check the class against a real project:

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=my-project
```

Then construct `ApiRegistry` with that project, call `getToolset` for a server
you know is registered, and call `getTools()` on the result. The call returns
the server's tools, and the deprecation warning appears once in the log.
