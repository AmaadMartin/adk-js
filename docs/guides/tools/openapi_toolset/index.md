# OpenAPIToolset

Turns an OpenAPI v3 specification into a set of callable tools. Reach for it
when an agent must call a REST API you already describe with a spec, instead of
hand-writing one `FunctionTool` per endpoint.

## Introduction

`OpenAPIToolset` parses a spec and generates one `RestApiTool` per operation. A
generated tool carries the operation's name, description and parameter schema,
so the model sees the same arguments the API declares. Calling the tool builds
the request, applies the credential, and performs the HTTP call.

Use it when the API is described by a spec. Write a `FunctionTool` instead when
the call needs logic the spec cannot express, and use `MCPToolset` when the
remote side already speaks the Model Context Protocol.

The toolset parses the spec once, in the constructor. The generated tools never
change afterwards, so the `configure*All` methods below mutate the tools that
already exist rather than rebuilding them.

## Get started

```ts
import {LlmAgent, OpenAPIToolset} from '@google/adk';

const toolset = new OpenAPIToolset({specStr: mySpecYaml, specType: 'yaml'});

const agent = new LlmAgent({
  name: 'users_agent',
  model: 'gemini-2.0-flash',
  instruction: 'Answer questions about users with the API tools.',
  tools: [toolset],
});
```

Pass an already-parsed spec with `specDict` instead of `specStr`. `specDict`
wins when you pass both.

## Selecting tools

`getTool` returns one generated tool, so you can give an agent a single
endpoint:

```ts
const getUsers = toolset.getTool('get_users');
```

The toolset names each tool after the operation, converted to snake_case. It
returns `undefined` when no tool carries that name.

`prefix` prepends `${prefix}_` to every generated name. The toolset applies the
prefix at construction, so `getTool` and a `toolFilter` list both match the
prefixed name:

```ts
const toolset = new OpenAPIToolset({specDict: spec, prefix: 'crm'});
toolset.getTool('crm_get_users'); // the tool
toolset.getTool('get_users'); // undefined
```

`toolFilter` restricts what `getTools` returns. Pass a `string[]` of names, or a
predicate that decides per tool.

## Authentication

`authScheme` and `authCredential` apply to every generated tool and override
the scheme the spec declares for the operation:

```ts
import {AuthCredentialTypes, OpenAPIToolset} from '@google/adk';

const toolset = new OpenAPIToolset({
  specDict: spec,
  authScheme: {type: 'apiKey', in: 'header', name: 'X-API-Key'},
  authCredential: {
    authType: AuthCredentialTypes.API_KEY,
    apiKey: process.env.MY_API_KEY,
  },
});
```

`credentialKey` is the key the tools use to request a credential
interactively and to cache the exchanged result. Set it when several toolsets
share one credential. `configureCredentialKeyAll` changes it after
construction:

```ts
toolset.configureCredentialKeyAll('rotated-key');
```

## Custom transport

Every generated tool calls `globalThis.fetch` by default. `fetchFn` replaces it
for every tool in the toolset:

```ts
const toolset = new OpenAPIToolset({specDict: spec, fetchFn: myFetch});
```

Pass a wrapper to route calls through a proxy, to supply a custom certificate
authority, or to sign each request. `configureFetchAll` installs one after
construction:

```ts
toolset.configureFetchAll(myFetch);
```

The tool reads `globalThis.fetch` at call time, so replacing the global also
takes effect on tools built earlier.

## Failure modes

The constructor throws, so a bad spec fails where you build the toolset and not
on the first model turn.

| Condition                                               | Error                                               |
| ------------------------------------------------------- | --------------------------------------------------- |
| Neither `specDict` nor `specStr`                        | `Either specDict or specStr must be provided.`      |
| The spec string parses to an array, `null`, or a scalar | `The OpenAPI specification must be an object`       |
| The spec string is malformed                            | The `SyntaxError` or YAML exception from the parser |

`specType` accepts `'json'` and `'yaml'`, and defaults to `'json'`. TypeScript
rejects any other value at compile time.
