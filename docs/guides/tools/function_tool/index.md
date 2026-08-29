# FunctionTool

`FunctionTool` wraps one of your functions so a model can call it. You give it
a name, a parameter schema and an `execute` callback. ADK turns that into the
function declaration it sends to the model, validates the arguments the model
returns, and runs your callback. Reach for it whenever the work is a plain
function; the other tool classes exist for toolsets, remote servers and
built-in model features.

## Introduction

A model cannot call your code directly. It can only emit a function call that
names a tool and carries arguments. `FunctionTool` is the bridge in both
directions.

Outbound, it builds a `FunctionDeclaration`. The name in that declaration is
the name ADK registers the tool under, so the model can never be told about a
tool it cannot invoke. The declaration is also shaped for the API that receives
it: the Gemini Developer API rejects most OpenAPI `format` values, so those are
dropped, while Vertex AI keeps them.

Inbound, it validates the model's arguments against your schema before your
callback runs. The model is not trusted to respect the schema you gave it, so a
Zod schema is parsed and a call missing a declared-required argument is
answered with an error telling the model to retry.

`LongRunningFunctionTool` is the same tool for work that finishes after the
turn does. `AgentTool` wraps an agent instead of a function.

## Get started

```ts
import {FunctionTool} from '@google/adk';
import {z} from 'zod/v3';

const getWeather = new FunctionTool({
  name: 'get_weather',
  description: 'Returns the current weather for a city.',
  parameters: z.object({city: z.string()}),
  execute: ({city}) => ({temperatureC: 21, city}),
});
```

`description` is optional and defaults to an empty string. Give the model one:
it is the only thing that tells the model when to call your tool.

`name` is also optional. It falls back to the `execute` function's own name:

```ts
const tool = new FunctionTool({
  description: 'Returns the current weather for a city.',
  parameters: z.object({city: z.string()}),
  execute: function get_weather({city}) {
    return {temperatureC: 21, city};
  },
});
```

Write `name` whenever `execute` is an arrow function defined inline.
JavaScript names such a function after the property it is assigned to, so the
tool is advertised to the model as `execute`.

## Reporting a failure

Return an object with a truthy `error` property. ADK records
`error.type=TOOL_ERROR` on the tool's `execute_tool` trace span, so a failed
call is distinguishable from a successful one in your traces.

```ts
const readFile = new FunctionTool({
  name: 'read_file',
  description: 'Reads a project file.',
  parameters: z.object({path: z.string()}),
  execute: ({path}) => {
    if (!path.startsWith('src/')) {
      return {error: `refusing to read outside src/: ${path}`};
    }
    return {contents: '...'};
  },
});
```

Detection is skipped while the tool asks for credentials or for confirmation.
Those responses also carry an `error` key, and neither is a failure.

Throwing from `execute` is the other option. ADK wraps the message as
`Error in tool '<name>': <message>` and the error propagates.

## Live tools and the input stream

During a bidirectional (live) run, `execute` receives a third argument: the
`LiveRequestQueue` the framework registered under this tool's name. Use it to
read what the user sends while your tool is still running. It is `undefined`
outside a live run.

```ts
const monitorPrice = new FunctionTool({
  name: 'monitor_stock_price',
  description: 'Streams price updates until the user stops it.',
  parameters: z.object({symbol: z.string()}),
  execute: async ({symbol}, _toolContext, inputStream) => {
    const request = await inputStream?.get();
    return {symbol, stoppedBy: request?.content?.parts?.[0]?.text};
  },
});
```

The lookup uses the tool's registered name, so one tool cannot be handed
another tool's queue.

## Declaration caching

Building a declaration converts your schema, which an agent would otherwise
repeat for every tool on every model call. `FunctionTool` builds it once and
caches it. The cache is keyed on the API variant and on the
`JSON_SCHEMA_FOR_FUNC_DECL` feature, so changing either rebuilds.

Every call still returns a fresh copy. A caller that prefixes the name or
annotates the description — as `LongRunningFunctionTool` does — cannot corrupt
the cached declaration or your own schema object.

## Declaring parameters as a raw JSON schema

`JSON_SCHEMA_FOR_FUNC_DECL` is an experimental feature, off by default. Turn it
on and the declaration carries `parametersJsonSchema` (a standard JSON schema)
instead of `parameters` (a genai `Schema`). Exactly one of the two is ever set.

```ts
import {FeatureName, overrideFeatureEnabled} from '@google/adk';

overrideFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL, true);
```

`ADK_ENABLE_JSON_SCHEMA_FOR_FUNC_DECL=true` does the same from the environment.
