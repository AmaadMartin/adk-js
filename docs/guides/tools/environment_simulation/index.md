# Environment simulation

Runs an agent against simulated tools instead of the real ones. Reach for it
when you want to test an agent against a tool that is slow, costly, or not
built yet, and when you want a tool to fail on demand.

## Introduction

`EnvironmentSimulationConfig` describes what each tool should return. This
guide covers the runtime that reads it: one plugin you register on a `Runner`.

The plugin answers a tool call before the tool runs. For each call it does one
of three things:

- It returns nothing, and the real tool runs. That is what happens for a tool
  the configuration does not name.
- It returns an injected value. An injection rule fires first, before any model
  call.
- It asks a model to invent a response from the tool's own declaration.

`EnvironmentSimulationFactory` builds the plugin. Build the configuration with
`createEnvironmentSimulationConfig`, `createToolSimulationConfig`,
`createInjectionConfig` and `createInjectedError`, which validate their input
and fill in the defaults adk-python applies.

## Get started

```ts
import {
  EnvironmentSimulationFactory,
  MockStrategy,
  createEnvironmentSimulationConfig,
  createInjectedError,
  createInjectionConfig,
  createToolSimulationConfig,
} from '@google/adk';

const plugin = EnvironmentSimulationFactory.createPlugin(
  createEnvironmentSimulationConfig({
    toolSimulationConfigs: [
      // Always fail get_weather with a 404.
      createToolSimulationConfig({
        toolName: 'get_weather',
        injectionConfigs: [
          createInjectionConfig({
            injectedError: createInjectedError({
              injectedHttpErrorCode: 404,
              errorMessage: 'not found',
            }),
          }),
        ],
      }),
      // Mock book_flight from its own declaration, with a model.
      createToolSimulationConfig({
        toolName: 'book_flight',
        mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
      }),
    ],
  }),
);

const runner = new Runner({
  appName: 'travel-app',
  agent,
  plugins: [plugin],
  sessionService,
});
```

`get_weather` now returns `{error_code: 404, error_message: 'not found'}` and
never runs. `book_flight` returns whatever the simulation model produced. Any
other tool of the agent runs normally.

## Injection rules run before the mock strategy

The rules of a tool are tried in the order you declared them. A rule fires when
two conditions hold:

- Its `matchArgs` entries all appear in the call arguments, compared by value.
  A rule without `matchArgs` applies to every call.
- A draw against `injectionProbability` lands strictly below it. The default
  probability is 1, so a rule without one fires on every call.

A rule that fires waits `injectedLatencySeconds`, then returns its
`injectedError` or its `injectedResponse`. Nothing after it runs, so no model
is called. A rule that does not fire hands over to the next rule.

Set `randomSeed` to make the draw reproducible:

```ts
createInjectionConfig({
  injectionProbability: 0.5,
  randomSeed: 100,
  injectedResponse: {status: 'degraded'},
});
```

adk-python seeds CPython's Mersenne Twister. adk-js has no seedable built-in
generator, so it ships mulberry32. Both replay the same draws for one seed, but
the draw for a given seed differs between the two SDKs.

## The two mock strategies

`mockStrategyType` decides what answers the calls no rule fired on.

- `MOCK_STRATEGY_UNSPECIFIED`, the default, answers nothing. The plugin logs a
  warning naming the tool and lets the real tool run.
- `MOCK_STRATEGY_TOOL_SPEC` asks `simulationModel` for a JSON response, from
  the tool's declaration, description and arguments.
- `MOCK_STRATEGY_TRACING` is withdrawn. It returns
  `{status: 'error', error_message: 'Not implemented'}`.

`MOCK_STRATEGY_TOOL_SPEC` reports an error rather than throwing when the model
misbehaves:

| What happened                                 | What the tool receives                       |
| --------------------------------------------- | -------------------------------------------- |
| The tool has no declaration                   | `{status, error_message}`, and no model call |
| The model did not return JSON                 | `{status, error_message, llm_output}`        |
| The model returned JSON that is not an object | `{status, error_message, llm_output}`        |

These keys stay snake_case, because the model reads them as a tool result.

## The state store keeps mocked calls consistent

A mocked `create_ticket` invents a ticket id. A mocked `get_ticket` should then
find it. The engine keeps a state store for that, shared by every call it
serves, for the lifetime of the plugin.

To know which tool creates what, the engine asks the simulation model once, on
the first call that could need a mock strategy. The result is a tool connection
map: for each shared parameter, the tools that create it and the tools that
read it.

```ts
import {ToolConnectionMap} from '@google/adk';

const map: ToolConnectionMap = {
  statefulParameters: [
    {
      parameterName: 'ticket_id',
      creatingTools: ['create_ticket'],
      consumingTools: ['get_ticket'],
    },
  ],
};
```

When a creating tool is mocked, the engine searches the response for the
parameter, and stores the whole response under that value. Later calls see the
store in their prompt. Two limits are worth knowing. The analysis runs at most
once per plugin, and it is skipped when the agent is not an `LlmAgent`, in
which case no map exists and no state is tracked. The store grows for as long
as the plugin lives, so build one plugin per test run rather than sharing one
across many.

## Using a callback instead of a plugin

`createCallback` returns the same logic as a `SingleBeforeToolCallback`, so it
can be set on one agent rather than on the whole runner:

```ts
const agent = new LlmAgent({
  name: 'travel_agent',
  model: 'gemini-flash-latest',
  tools: [getWeather, bookFlight],
  beforeToolCallback: EnvironmentSimulationFactory.createCallback(config),
});
```

It returns `undefined` when the real tool should run. Each call to
`createCallback` or `createPlugin` builds its own engine, so two simulators
never share a state store.

## Turning the feature off

The runtime is gated by the experimental `ENVIRONMENT_SIMULATION` feature,
which is on by default. `createCallback`, `createPlugin` and the
`EnvironmentSimulationEngine` constructor all throw when it is off:

```ts
import {FeatureName, overrideFeatureEnabled} from '@google/adk';

overrideFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION, false);

EnvironmentSimulationFactory.createPlugin(config);
// Error: Feature ENVIRONMENT_SIMULATION is not enabled.
```

The environment variable `ADK_DISABLE_ENVIRONMENT_SIMULATION` does the same
from outside the process.
