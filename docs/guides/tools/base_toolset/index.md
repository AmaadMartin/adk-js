# Toolset tool-name prefixing

`BaseToolset` gives every toolset a `prefix`. `getToolsWithPrefix()` applies it
to the names the model sees, and caches the result for the invocation. Reach for
a prefix when one agent mounts two toolsets that expose the same tool name.

## Introduction

A toolset lists tools it does not own. Two Model Context Protocol (MCP) servers
can each advertise a tool called `search`, and an agent that mounts both fails
with `Duplicate tool name: search`. A prefix separates them: the model sees
`serverA_search` and `serverB_search`.

The prefix belongs to the base class, not to the subclass. A subclass implements
`getTools()` and returns the names its backend advertised. The framework calls
`getToolsWithPrefix()`, which copies each tool and renames the copy. This split
matters in two places you can observe:

- A string-array `toolFilter` matches the **unprefixed** name, because the
  filter runs inside `getTools()`. Write the name the server advertised.
- `MCPToolset` calls the MCP server with the unprefixed name, whatever prefix
  you set.

Prefixing never changes the tool your subclass returned. The copy keeps the
prototype, the description and every other property of the original, and it
shadows `_getDeclaration()` so the declaration name matches the tool name.

## Get started

```ts
import {BaseTool, BaseToolset, FunctionTool, LlmAgent} from '@google/adk';

class WeatherToolset extends BaseToolset {
  constructor(prefix: string) {
    super([], prefix);
  }

  async getTools(): Promise<BaseTool[]> {
    return [
      new FunctionTool({
        name: 'forecast',
        description: 'Returns the forecast for tomorrow.',
        execute: async () => ({sky: 'clear'}),
      }),
    ];
  }
}

const agent = new LlmAgent({
  name: 'weather_agent',
  tools: [new WeatherToolset('europe'), new WeatherToolset('asia')],
});

const tools = await agent.canonicalTools();
// tools[0].name is 'europe_forecast', tools[1].name is 'asia_forecast'
```

An empty string and an omitted prefix both mean "no prefix". In that case
`getToolsWithPrefix()` returns the array `getTools()` returned, unchanged.

## The invocation cache

`getToolsWithPrefix()` caches its result against the invocation id of the
context it was given. A second call within the same invocation returns the same
array instance, so a toolset that lists a remote server is queried once per
invocation rather than once per LLM request.

A toolset whose tool list changes within one invocation must turn the cache off
in its constructor:

```ts
class DynamicToolset extends BaseToolset {
  constructor() {
    super([]);
    this.useInvocationCache = false;
  }
  // ...
}
```

`SkillToolset` does this, because the model activates skills mid-invocation and
each activation adds tools.

A call with no context uses `undefined` as the cache key, so two context-free
calls share one cache entry. If `getTools()` throws, the cache is left untouched
and the next call retries.

## Closing, config and auth

`close()` is a no-op on the base class. Implement it only when your toolset holds
a resource, such as an open session.

`fromConfig(config, configAbsPath)` is a static hook for a toolset declared in a
configuration file. The base implementation throws
`fromConfig() not implemented for toolset: <ClassName>`. `adk-js` has no
configuration loader yet, so nothing calls it; override it in a subclass that
needs one.

`getAuthConfig()` returns `undefined` on the base class. A toolset that needs
credentials overrides it and returns an `AuthConfig`. Nothing in `adk-js` reads
that value yet, so your toolset must still obtain its own credential. Override
the method to declare what the toolset needs; do not rely on the framework to
fill `exchangedAuthCredential` for you.
