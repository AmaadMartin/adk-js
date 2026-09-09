# OpenAPIToolset

Turns an OpenAPI v3 specification into a set of callable tools. Reach for it
when an agent must call a REST API you already describe with a spec, instead of
hand-writing one `FunctionTool` per endpoint.

## Introduction

`OpenAPIToolset` parses a spec and generates one `RestApiTool` per operation. A
generated tool carries the operation's name, description and parameter schema,
so the model sees the same arguments the API declares. Calling the tool builds
the request, applies the credential, and performs the HTTP call.

Write a `FunctionTool` instead when the call needs logic the spec cannot
express. Use `MCPToolset` when the remote side already speaks the Model Context
Protocol.

The toolset parses the spec once, in the constructor, and never rebuilds the
tools. The `configure*All` methods below therefore mutate the tools that already
exist, and take effect on the next call.

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

`specDict` takes an already-parsed spec, and wins when you pass both.

## Selecting tools

`getTool` returns one generated tool, so you can give an agent a single
endpoint. The toolset names each tool after the operation, converted to
snake_case, and returns `undefined` when no tool carries that name.

`prefix` is applied at construction, so `getTool` and an array `toolFilter`
both match the prefixed name:

```ts
const toolset = new OpenAPIToolset({specDict: spec, prefix: 'crm'});
toolset.getTool('crm_get_users'); // the tool
toolset.getTool('get_users'); // undefined
```

A predicate `toolFilter` needs a `ReadonlyContext` to run. `getTools()` called
without one returns every tool and logs a warning.

## Rotating credentials and transport

Each tool calls `globalThis.fetch` unless you pass `fetchFn`. Pass a wrapper to
route calls through a proxy, to supply a custom certificate authority, or to
sign each request.

`configureFetchAll` and `configureCredentialKeyAll` replace what the constructor
set, on every tool the toolset built:

```ts
toolset.configureFetchAll(myFetch);
toolset.configureCredentialKeyAll('rotated-key');
```

`fetchFn` is the TypeScript equivalent of the Python toolset's `ssl_verify` and
`httpx_client_factory`, which are httpx options with no portable `fetch` form.

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
