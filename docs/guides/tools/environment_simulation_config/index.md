# Environment simulation config

`EnvironmentSimulationConfig` describes a simulated tool environment: which
tools are mocked, how their responses are produced, and which calls fail on
purpose. Reach for it when you want to exercise an agent against tools that
are unavailable, expensive, or hard to drive into a failure state.

## Introduction

An agent that calls real tools is hard to test. The tool may need credentials,
it may cost money per call, and you cannot ask it for a 503 on demand. A
simulated environment replaces the tool with a mock and lets you script what
the agent sees.

The configuration has three layers.

- `InjectionConfig` scripts one deviation: a specific error, or a specific
  response, applied to matching calls with a probability and an optional
  latency.
- `ToolSimulationConfig` binds those injections to one tool, and names the
  `MockStrategy` that handles every call no injection catches.
- `EnvironmentSimulationConfig` collects the per-tool configurations and names
  the model that generates the mock responses.

Each type is a plain value object. A `create*` factory validates the input and
throws `InputValidationError` when the configuration cannot work, so a mistake
surfaces where you write the config rather than midway through an agent run.

These types are experimental and gated on the `ENVIRONMENT_SIMULATION` feature,
which is on by default. Set `ADK_DISABLE_ENVIRONMENT_SIMULATION=true` to turn
the factories off.

## Get started

The smallest useful configuration mocks one tool and fails one call in ten:

```ts
import {
  MockStrategy,
  createEnvironmentSimulationConfig,
  createInjectedError,
  createInjectionConfig,
  createToolSimulationConfig,
} from '@google/adk';

const config = createEnvironmentSimulationConfig({
  toolSimulationConfigs: [
    createToolSimulationConfig({
      toolName: 'get_weather',
      mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
      injectionConfigs: [
        createInjectionConfig({
          injectionProbability: 0.1,
          injectedError: createInjectedError({
            injectedHttpErrorCode: 503,
            errorMessage: 'weather service is unavailable',
          }),
        }),
      ],
    }),
  ],
});
```

`config.simulationModel` is `gemini-2.5-flash`, and
`config.simulationModelConfiguration` turns thinking output off with a budget
of 10240 tokens. Override either through the same factory.

To return a canned payload instead of an error, set `injectedResponse`:

```ts
const alwaysSunny = createInjectionConfig({
  matchArgs: {city: 'Sunnyvale'},
  injectedResponse: {conditions: 'sunny', temperatureC: 21},
});
```

## What the factories reject

Every rule below matches adk-python.

- An injection must set exactly one of `injectedError` and `injectedResponse`.
  Neither injects nothing, and both contradict each other. An empty
  `injectedResponse` counts as unset.
- `injectedLatencySeconds` may not exceed 120. There is no lower bound.
- A tool with no injections may not use `MOCK_STRATEGY_UNSPECIFIED`, because
  nothing would then answer its calls.
- `toolSimulationConfigs` may not name one tool twice.
- Omitting `toolSimulationConfigs` gives you an empty list, but passing an
  empty list is an error. adk-python behaves the same way, because pydantic
  runs a field validator over a supplied value and never over a default.

adk-js is stricter than adk-python in one place: an unknown key is rejected
rather than dropped in silence, so a typo in a configuration document is
reported.

## Feeding a prior run to the mocks

`tracing` takes a prior agent run trace as a JSON string, and
`environmentData` takes environment-specific data such as a small database
dump. Both reach the mock strategies, which use them for context.

```ts
const contextual = createEnvironmentSimulationConfig({
  toolSimulationConfigs: [
    createToolSimulationConfig({
      toolName: 'get_weather',
      mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
    }),
  ],
  tracing: priorRunTraceJson,
  environmentData: databaseDumpJson,
});
```

## The deprecated agent_simulator alias

These types used to live in `tools/agent_simulator/agent_simulator_config`,
and `tracing` used to be called `tracingPath`. Both still work. The module
warns once when it is evaluated, and `createAgentSimulatorConfig` warns once
when you pass `tracingPath`. An explicit `tracing` wins over `tracingPath`.

```ts
import {createAgentSimulatorConfig} from '@google/adk/tools/agent_simulator/agent_simulator_config';

const legacy = createAgentSimulatorConfig({
  toolSimulationConfigs,
  tracingPath: priorRunTraceJson, // forwarded to `tracing`
});
```

`AgentSimulatorConfig` is a type alias for `EnvironmentSimulationConfig`, so a
value built either way is the same shape. The package barrel does not re-export
this module, which is why the import above names the subpath: importing
`@google/adk` must not warn.
