# OpenAPIToolset

Turns an OpenAPI 3 specification into a set of callable tools. Reach for it when
an agent must call a REST API that already publishes a spec, instead of writing
one `FunctionTool` per endpoint.

## Introduction

`OpenAPIToolset` parses a spec and generates one `RestApiTool` per operation.
Each generated tool carries the operation's parameters as its function
declaration, so the model sees typed arguments, and calling the tool issues the
HTTP request with `fetch`.

The toolset owns the concerns that are the same for every operation in one API:
the authentication scheme, the credential, the header provider and the TLS
settings. You configure them once on the toolset and it pushes them to every
tool it generated. A `RestApiTool` still accepts each of them on its own, which
is what you use when one endpoint differs from the rest.

An `LlmAgent` accepts the toolset directly in its `tools` array, so the agent
sees every generated tool. Use `toolFilter` to narrow that set, or `getTool` to
pick out a single tool and pass only that one.

## Get started

```ts
import {LlmAgent, OpenAPIToolset} from '@google/adk';

const toolset = new OpenAPIToolset({specStr: openApiYaml, specType: 'yaml'});

const agent = new LlmAgent({
  name: 'users_api',
  model: 'gemini-2.5-flash',
  tools: [toolset],
});
```

`specDict` takes an already-parsed spec instead of a string. With `specStr` and
no `specType`, a string that starts with `---` is read as YAML and everything
else as JSON.

## Select one tool

`getTool` returns a single generated tool by name, or `undefined`.

```ts
const getUsers = toolset.getTool('get_users');
```

The name is the one the toolset generated: a snake_case form of the operation
id, with `prefix` already applied. A toolset built with `prefix: 'test'`
answers to `getTool('test_get_users')`, not to `getTool('get_users')`.

## Filter the tools

`toolFilter` accepts a list of tool names or a predicate.

```ts
const readOnly = new OpenAPIToolset({
  specDict,
  toolFilter: (tool) => tool.name.startsWith('get_'),
});

const tools = await readOnly.getTools();
```

The predicate receives the `ReadonlyContext` of the current invocation as its
second argument. `getTools()` called outside an invocation passes `undefined`
there, and the filter still runs, so a predicate that reads the context must
handle the absent case.

## TLS certificate verification

`sslVerify` sets how the generated tools verify the server certificate. Use it
when requests pass through a proxy that terminates TLS with its own certificate
authority.

```ts
const toolset = new OpenAPIToolset({
  specDict,
  sslVerify: '/etc/ssl/certs/corp-ca.pem',
});
```

The accepted values are:

| Value               | Effect                                              |
| ------------------- | --------------------------------------------------- |
| absent, or `true`   | Verify against the system certificate authority.    |
| `false`             | Do not verify. Insecure, and not recommended.       |
| a string            | Path to a PEM certificate authority bundle file.    |
| an `HttpDispatcher` | A dispatcher your application built, used as it is. |

`configureSslVerifyAll` changes the setting on every generated tool after
construction. Call it with no argument to restore the default.

```ts
toolset.configureSslVerifyAll(false);
toolset.configureSslVerifyAll();
```

A path or `false` makes ADK build an `undici` `Agent`. `undici` is an optional
peer dependency, so install it in the application that needs one:

```
npm install undici
```

An `HttpDispatcher` you supply yourself is passed straight to `fetch` and needs
no install. The default setting attaches no dispatcher at all, so an application
that never sets `sslVerify` never loads `undici`.

## Authentication

`authScheme` and `authCredential` apply to every generated tool.
`credentialKey` names the slot ADK uses to cache the exchanged credential
across the tools of one toolset.

```ts
import {AuthCredentialTypes, OpenAPIToolset} from '@google/adk';

const toolset = new OpenAPIToolset({
  specDict,
  authScheme: {type: 'apiKey', name: 'key', in: 'header'},
  authCredential: {authType: AuthCredentialTypes.API_KEY, apiKey},
  credentialKey: 'users-api',
});
```

`getAuthConfig()` returns the `AuthConfig` the toolset built from those three
options, or `undefined` when no `authScheme` was given. The object is the
toolset's own, so a host can write `exchangedAuthCredential` into it before it
calls `getTools()`. With no `credentialKey`, the config carries
`DEFAULT_OPENAPI_CREDENTIAL_KEY`.

## Failure modes

The constructor parses the spec, so a bad spec throws there rather than at the
first tool call.

| Condition                                                 | Error                                                |
| --------------------------------------------------------- | ---------------------------------------------------- |
| Neither `specDict` nor `specStr`                          | `Either specDict or specStr must be provided.`       |
| A `specType` that is not `json` or `yaml`                 | `Unsupported spec type: <value>`                     |
| A spec string that parses to a scalar, `null` or an array | `The OpenAPI specification must be an object`        |
| A `sslVerify` path that cannot be read                    | The underlying `node:fs` error.                      |
| `sslVerify` needs `undici` and it is absent               | An error naming the package and the install command. |

A JSON or YAML syntax error propagates from the parser unchanged.
