# BaseTool metadata, response scheduling and config construction

`BaseTool` carries three optional members beside `name`, `description` and
`isLongRunning`: `customMetadata`, `responseScheduling` and `defersResponse`.
It also exposes a static `fromConfig`, which builds a tool from a declarative
config. Reach for them when a tool needs to carry data ADK does not interpret,
to control when a live model reacts to its answer, or to be constructed from a
config file instead of from code.

## Introduction

A tool declaration tells the model what a tool does. These members tell ADK and
your own code how to treat the tool around that call.

`customMetadata` is storage. ADK never reads it, so a tool manifest, a
deployment identifier or a routing hint survives on the tool instance for your
code to pick off later. `responseScheduling` and `defersResponse` change the
event a tool call produces: the first stamps a scheduling mode onto the emitted
`FunctionResponse`, the second suppresses that response entirely when the tool
returns nothing. `fromConfig` is the construction seam a config loader calls,
and the method a tool with extra constructor parameters overrides.

`defersResponse` is close to `isLongRunning` and the difference matters. Both
skip the synthesized `FunctionResponse` when the tool returns nothing. Only
`isLongRunning` also lists the call in `event.longRunningToolIds`, which drives
A2A conversion, plugin logging and interrupt tracking.

## Get started

```ts
import {BaseTool, BaseToolParams} from '@google/adk';
import {FunctionDeclaration} from '@google/genai';

class InventoryTool extends BaseTool {
  override _getDeclaration(): FunctionDeclaration {
    return {name: this.name, description: this.description};
  }

  async runAsync(): Promise<unknown> {
    return {inStock: 12};
  }
}

const inventory = new InventoryTool({
  name: 'inventory',
  description: 'Looks up stock levels.',
  customMetadata: {manifestVersion: 3, owner: 'catalog'},
});

// inventory.customMetadata is {manifestVersion: 3, owner: 'catalog'}
```

## Custom metadata

The whole object must be JSON serializable, because a caller that persists a
tool manifest expects to serialize it.

`customMetadata` is not `readonly`. A tool whose constructor does not forward
it — `FunctionTool`, for one — takes it by assignment:

```ts
import {FunctionTool} from '@google/adk';

const notify = new FunctionTool({
  name: 'notify',
  description: 'Sends a notification.',
  execute: async () => ({sent: true}),
});
notify.customMetadata = {owner: 'catalog'};
```

## Response scheduling

`responseScheduling` sets when the model reacts to this tool's answer. It
applies to the Live API; a model without asynchronous function calling ignores
it. The value is the `FunctionResponseScheduling` enum from `@google/genai`:
`SILENT` feeds the answer back without starting a model turn, `WHEN_IDLE`
defers the reaction until the model is idle, and `INTERRUPT` reacts
immediately.

```ts
import {FunctionTool} from '@google/adk';
import {FunctionResponseScheduling} from '@google/genai';

const notify = new FunctionTool({
  name: 'notify',
  description: 'Sends a notification.',
  execute: async () => ({sent: true}),
});
notify.responseScheduling = FunctionResponseScheduling.SILENT;
```

The emitted `FunctionResponse` then carries `scheduling: 'SILENT'`. A tool that
sets nothing emits a response with no `scheduling` key at all, so existing
tools keep their current event shape.

## Deferred responses

`defersResponse` is internal to ADK. It is public because the flow that reads
it lives outside the class, not because it is part of the public API, and it
may change without notice.

Set it on a tool that answers its own call later — a wrapper that delegates to
a sub-agent, or a webhook-style callback. When `runAsync` returns `null` or
`undefined`, ADK emits no `FunctionResponse` for that call and something else
supplies one later. Any action the tool recorded on its tool context (a state
delta, an artifact delta, a transfer) still reaches the session in a
content-less event. A non-nullish return builds a normal response event.

## Construction from a config

`fromConfig(config, configAbsPath)` builds a tool from free key-value args, as
read from a config file. The base implementation reads the five parameters
`BaseTool` itself accepts: `name`, `description`, `isLongRunning`,
`customMetadata` and `responseScheduling`.

```ts
const tool = InventoryTool.fromConfig(
  {name: 'inventory', description: 'Looks up stock levels.'},
  '/abs/path/to/agent.yaml',
);
```

`configAbsPath` is the absolute path of that config file. The base
implementation names it in validation errors; an override uses it to resolve a
path given relative to the config.

Validation throws a plain `Error` naming the offending key and the config path
when `name` is missing or empty, when `description` is missing, when
`isLongRunning` is not a boolean, when `customMetadata` is not an object, or
when `responseScheduling` is not a member of the enum. Any other key is
reported through `logger.warn` and ignored.

A tool whose constructor takes more than `BaseToolParams` overrides the method:

```ts
import {BaseTool, BaseToolParams, ToolArgsConfig} from '@google/adk';

class GreetingTool extends BaseTool {
  constructor(
    params: BaseToolParams,
    readonly greeting: string,
  ) {
    super(params);
  }

  static override fromConfig(
    config: ToolArgsConfig,
    _configAbsPath: string,
  ): GreetingTool {
    return new GreetingTool(
      {name: String(config['name']), description: 'greets'},
      String(config['greeting']),
    );
  }

  async runAsync(): Promise<unknown> {
    return this.greeting;
  }
}
```

Calling `fromConfig` on `BaseTool` itself does not compile, because `BaseTool`
is abstract. The base implementation returns `BaseTool`; an override declares
its own concrete return type, as `GreetingTool` does above.
