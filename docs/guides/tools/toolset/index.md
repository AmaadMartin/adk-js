# BaseToolset

A toolset is a collection of tools an agent lists at run time, rather than a
fixed array you write out. Extend `BaseToolset` when the tools come from
somewhere else — a Model Context Protocol (MCP) server, an OpenAPI document, a
registry — or when the set depends on the current invocation.

## Introduction

An `LlmAgent` accepts tools and toolsets in the same `tools` array. A tool is a
single callable. A toolset is asked for its tools on every request, so the list
can change between invocations.

Two toolsets can advertise a tool of the same name. The model addresses a tool
by name only, so a collision is fatal: `BaseTool.processLlmRequest` throws
`Duplicate tool name: <name>`. A toolset therefore takes an optional prefix.
The base class applies it to the tool name and to the name in the tool's
`FunctionDeclaration`, so the two always agree and the model's call still
routes.

Listing can be expensive — an MCP toolset opens a session and asks the server.
The base class caches the prefixed list for the invocation it was built in, so
a toolset is listed once per invocation instead of once per model request.

Implement `getTools`. The framework calls `getToolsWithPrefix`, which wraps it.

## Get started

```ts
import {BaseTool, BaseToolset, FunctionTool, LlmAgent} from '@google/adk';

class WeatherToolset extends BaseToolset {
  constructor() {
    super([], 'weather');
  }

  async getTools(): Promise<BaseTool[]> {
    return [
      new FunctionTool({
        name: 'forecast',
        description: 'Returns the forecast',
        execute: async () => 'sunny',
      }),
    ];
  }
}

const agent = new LlmAgent({
  name: 'weather_agent',
  model: 'gemini-2.0-flash',
  tools: [new WeatherToolset()],
});

// The model sees `weather_forecast`.
const tools = await agent.canonicalTools();
```

`getTools` returns the tool under its own name, `forecast`. The prefix is
applied above it, so a second toolset can expose its own `forecast` without a
collision.

## Filtering

The first constructor argument is a `toolFilter`: either a list of tool names
or a predicate over the tool and the context.

```ts
import {BaseTool, BaseToolset, ReadonlyContext} from '@google/adk';

class CatalogToolset extends BaseToolset {
  constructor(private readonly discovered: BaseTool[]) {
    // Only `search` is exposed, whatever else the source advertises.
    super(['search'], 'catalog');
  }

  async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    return context
      ? this.discovered.filter((tool) => this.isToolSelected(tool, context))
      : this.discovered;
  }
}
```

A filter names the **unprefixed** tool, because filtering happens inside
`getTools` and the prefix is applied after it. Write the names the source
advertises, not the names the model will see.

## The invocation cache

`getToolsWithPrefix` keys its cache on `context.invocationId`. A second call in
the same invocation returns the identical array; a call in a new invocation
lists again. A call that passes no context is never cached, because nothing
would bound how long its list stays current.

Turn the cache off when your tool list changes within one invocation:

```ts
class GrowingToolset extends BaseToolset {
  private tools: BaseTool[] = [];

  constructor() {
    super([]);
    this.useInvocationCache = false;
  }

  async getTools(): Promise<BaseTool[]> {
    return this.tools;
  }
}
```

`SkillToolset` does exactly this: the model loads a skill mid-invocation and
the skill brings more tools with it, so a frozen first listing would hide them.

## Releasing resources

`close()` is a no-op by default, so a toolset holding nothing does not need it.
Override it when you own a connection, a file, or a session. The `Runner` calls
it on every toolset when an invocation ends.

```ts
class ServerToolset extends BaseToolset {
  constructor(private readonly session: {disconnect(): Promise<void>}) {
    super([]);
  }

  async getTools(): Promise<BaseTool[]> {
    return [];
  }

  override async close(): Promise<void> {
    await this.session.disconnect();
  }
}
```
