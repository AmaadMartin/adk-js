# BaseTool configuration and response deferral

`BaseTool` gives every tool three shared behaviours: a factory that builds a
tool from a config bag, a flag that lets another component supply the tool's
`FunctionResponse`, and a default `runAsync` for a tool that never runs on the
client. Reach for them when you load tools from a config file, when an
orchestrator answers a tool call on the tool's behalf, or when you write a tool
the model runs server-side.

## Introduction

A tool config comes from outside the type system. It is a block in a YAML or
JSON file, so its shape is whatever the tool's own constructor accepts.
`BaseTool.fromConfig` is the seam between that untyped bag and a live tool
instance. The default validates the three keys `BaseTool` reads (`name`,
`description`, `isLongRunning`), forwards every other key to the constructor,
and returns the instance. A subclass overrides it when construction needs more
than that — resolving a path the config states relative to the config file, for
example. That is why the seam is asynchronous here while the Python method is
synchronous: resolving a reference in TypeScript means a dynamic `import()`.

`defersResponse` answers a different question: who writes the
`FunctionResponse` for this call. A normal tool returns a value and the
function-call flow turns it into a response event. A deferring tool returns
nothing, and some other component sends the matching response later. Set the
flag and the flow emits no automatic event for that call.

`isLongRunning` skips the automatic event the same way, so the two are easy to
confuse. The difference is what else `isLongRunning` does: it records the call
in `event.longRunningToolIds`, which drives A2A conversion, plugin logging and
interrupt tracking. A deferring tool never appears in that set. Pick
`isLongRunning` for an operation that reports a resource id now and a result
later. Pick `defersResponse` when the call is not long running and only the
response is produced elsewhere.

`runAsync` used to be abstract, which forced every subclass to write one. A
built-in tool that the model executes server-side has nothing to run on the
client, so it had to ship an empty stub. The default now throws instead, so
such a tool can leave the method out.

## Get started

`fromConfig` validates the config and calls the constructor. Keys `BaseTool`
does not know about reach the constructor unchanged, so a subclass keeps its
own options.

```ts
import {BaseTool, BaseToolParams, RunAsyncToolRequest} from '@google/adk';

interface GreetToolParams extends BaseToolParams {
  greeting?: string;
}

class GreetTool extends BaseTool {
  private readonly greeting: string;

  constructor(params: GreetToolParams) {
    super(params);
    this.greeting = params.greeting ?? 'Hello';
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    return {message: `${this.greeting}, ${args['name'] as string}!`};
  }
}

const tool = await GreetTool.fromConfig(
  {name: 'greet', description: 'Greets a person.', greeting: 'Hi'},
  '/abs/path/to/agent.yaml',
);
```

## Validation

`fromConfig` calls `toBaseToolParams`, which throws `InputValidationError` when
a key it recognizes holds the wrong type. The message names the key and the
kind of value received. It never quotes the value, because a config can carry a
credential and error strings reach logs.

```ts
import {InputValidationError, toBaseToolParams} from '@google/adk';

try {
  toBaseToolParams({name: 42, description: 'Greets a person.'});
} catch (error: unknown) {
  if (error instanceof InputValidationError) {
    // Invalid tool config: "name" must be a string, got number.
  }
}
```

`name` must be a non-empty string, `description` must be a string, and
`isLongRunning` must be a boolean when it is present. `null` reports as `null`
and an array reports as `array`, rather than both reporting as `object`.

## Overriding fromConfig

A subclass whose constructor demands options beyond `BaseToolParams` cannot use
the default, because the default only knows how to pass `BaseToolParams`. The
compiler enforces this: `this` in the default is typed as a constructor taking
`BaseToolParams`, so such a subclass must override `fromConfig`. The override
receives `configAbsPath` unchanged and can resolve paths against it.

```ts
import {
  BaseTool,
  BaseToolParams,
  toBaseToolParams,
  ToolArgsConfig,
} from '@google/adk';
import {dirname, resolve} from 'node:path';

class PromptTool extends BaseTool {
  constructor(
    params: BaseToolParams,
    readonly promptPath: string,
  ) {
    super(params);
  }

  static override async fromConfig(
    config: ToolArgsConfig,
    configAbsPath: string,
  ): Promise<BaseTool> {
    const promptPath = resolve(
      dirname(configAbsPath),
      String(config['prompt']),
    );
    return new PromptTool(toBaseToolParams(config), promptPath);
  }
}
```

## Deferring a response

Set `defersResponse` after `super(...)`. It is not a constructor option: it is
internal, and ADK sets it on its own tools rather than exposing it in the
public config surface.

```ts
class DelegatingTool extends BaseTool {
  constructor(params: BaseToolParams) {
    super(params);
    this.defersResponse = true;
  }

  override async runAsync(_request: RunAsyncToolRequest): Promise<unknown> {
    return undefined;
  }
}
```

Two details decide whether the event is skipped:

- Only a nullish result defers. A falsy-but-present result — `''`, `0`,
  `false` — is a real result and still emits its response event.
- Actions the tool recorded on its context are never lost. A deferring tool
  that returned nothing but set a state delta, requested auth, or asked for a
  transfer still emits an actions-only event carrying them.

## Leaving runAsync out

A tool the model runs server-side implements no `runAsync`. Calling it is a
programming error, so the default rejects with an `Error` naming the tool.

```ts
class ServerSideTool extends BaseTool {}

const serverSide = new ServerSideTool({
  name: 'server_side',
  description: 'Runs inside the model.',
});
// Rejects: Tool server_side does not implement runAsync().
```
