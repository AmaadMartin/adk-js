# Environment simulation config

Describes how a tool behaves when the agent runs against a simulated
environment instead of the real one. Reach for it when you want a tool to fail
on demand, return a canned body, or be mocked from its own declaration.

## Introduction

`EnvironmentSimulationConfig` is a data object. It holds no connection, reads
no credentials and makes no network call. It names the tools to simulate, and
for each tool the rules that produce a response.

Two mechanisms produce that response, and they are tried in order:

- **Injection rules** fire first. A rule returns either an error or a response
  body, optionally only for calls whose arguments match, optionally with added
  latency, and optionally only some of the time.
- **A mock strategy** handles the calls no rule fired on.
  `MOCK_STRATEGY_TOOL_SPEC` asks a model to invent a plausible response from
  the tool's own declaration.

A tool needs at least one of the two, otherwise there is nothing to simulate
with and the config is rejected.

You build every part of the config with a factory rather than an object
literal. Each factory validates its input, applies the defaults adk-python
applies, and returns a fresh object. A later change to the object you passed in
cannot reach a config you already built.

`AgentSimulatorConfig` is the old name for the same shape. It still works, and
it is described at the end of this guide.

## Get started

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
    // Fail every call to get_weather with a 404.
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
    // Mock book_flight from its own tool declaration.
    createToolSimulationConfig({
      toolName: 'book_flight',
      mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
    }),
  ],
});

config.simulationModel; // 'gemini-2.5-flash'
```

A nested factory call is optional. `createEnvironmentSimulationConfig` also
accepts plain objects and validates them the same way:

```ts
const sameConfig = createEnvironmentSimulationConfig({
  toolSimulationConfigs: [
    {
      toolName: 'book_flight',
      mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
    },
  ],
});
```

## An injection rule sets an error or a response, never both

`createInjectionConfig` rejects a rule that sets neither `injectedError` nor
`injectedResponse`, and a rule that sets both. A rule that injects nothing has
no effect, and a call cannot both fail and succeed.

adk-python compares `bool(injected_error) == bool(injected_response)`, and an
empty dict is falsy in Python. adk-js reproduces that, so an empty
`injectedResponse` object counts as unset:

```ts
import {createInjectionConfig} from '@google/adk';

createInjectionConfig({injectedResponse: {}});
// InputValidationError: Invalid InjectionConfig: ...
// Either injectedError or injectedResponse must be set, but not both, and
// not neither.
```

Use `injectedResponse: {status: 'ok'}`, or any other non-empty body, when you
want the call to succeed.

## Omitting the tool list is not the same as emptying it

adk-python checks the tool list in a pydantic field validator, and pydantic
does not validate a default. Omitting the field therefore succeeds, while
passing an empty list fails. adk-js keeps that distinction:

```ts
import {createEnvironmentSimulationConfig} from '@google/adk';

createEnvironmentSimulationConfig().toolSimulationConfigs;
// []

createEnvironmentSimulationConfig({toolSimulationConfigs: []});
// InputValidationError: Invalid EnvironmentSimulationConfig:
// toolSimulationConfigs must be provided.
```

## A tool name appears at most once

Two configs for one tool are ambiguous, so the second is an error. The message
names the repeated tool:

```ts
createEnvironmentSimulationConfig({
  toolSimulationConfigs: [
    {toolName: 'dup', mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC},
    {toolName: 'dup', mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC},
  ],
});
// InputValidationError: Invalid EnvironmentSimulationConfig:
// Duplicate tool_name found: dup
```

Distinct names keep the order you gave them.

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

## Defaults and bounds

| Field                          | Default                                                             |
| ------------------------------ | ------------------------------------------------------------------- |
| `toolSimulationConfigs`        | `[]`                                                                |
| `simulationModel`              | `'gemini-2.5-flash'`                                                |
| `simulationModelConfiguration` | `{thinkingConfig: {includeThoughts: false, thinkingBudget: 10240}}` |
| `injectionConfigs`             | `[]`                                                                |
| `mockStrategyType`             | `MockStrategy.MOCK_STRATEGY_UNSPECIFIED`                            |
| `injectionProbability`         | `1`                                                                 |
| `injectedLatencySeconds`       | `0`                                                                 |

`injectedLatencySeconds` may not exceed 120. `injectionProbability` has no
bounds, because adk-python declares none.

Every factory rejects a key it does not know. adk-js is stricter than
adk-python here: adk-python's models take pydantic's default, so they drop an
unknown key without saying anything. The two SDKs also disagree on the
spelling, so `tool_simulation_configs` is one of the keys adk-js rejects. Use
`toolSimulationConfigs`.

## The deprecated AgentSimulatorConfig name

`AgentSimulatorConfig` was the earlier name of this config. It lives outside
the `@google/adk` barrel, on its own subpath, so that importing the package
does not warn callers who never used the old name:

```ts
import {createAgentSimulatorConfig} from '@google/adk/tools/agent_simulator/agent_simulator_config';
// WARN: ... agent_simulator_config is moved to the
// environment_simulation_config module, which @google/adk exports directly.
```

Evaluating that module logs one deprecation warning. The module re-exports
`MockStrategy`, `InjectedError`, `InjectionConfig` and `ToolSimulationConfig`,
along with their factories, so a caller on the old path needs no second import.

`createAgentSimulatorConfig` accepts one extra field, `tracingPath`, which was
renamed to `tracing`. Supplying it logs a second warning and forwards the value:

```ts
const config = createAgentSimulatorConfig({
  toolSimulationConfigs: [
    {
      toolName: 'get_weather',
      mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
    },
  ],
  tracingPath: 'prior_run_trace',
});

config.tracing; // 'prior_run_trace'
```

When you set both, `tracing` wins and `tracingPath` is dropped. The warning
still fires, because it reports that you used the old name. `tracingPath` never
appears on the returned config.

New code should use `createEnvironmentSimulationConfig` and `tracing`.

## Turning the feature off

The config is gated by the experimental `ENVIRONMENT_SIMULATION` feature, which
is on by default. Every factory throws when it is off, which matches
adk-python, where the `@experimental` decorator raises rather than warns.

The environment variable `ADK_DISABLE_ENVIRONMENT_SIMULATION` works from
outside the process:

```bash
ADK_DISABLE_ENVIRONMENT_SIMULATION=true node app.js
```

`overrideFeatureEnabled` works from inside it, and takes priority over the
environment:

```ts
import {
  FeatureName,
  createEnvironmentSimulationConfig,
  overrideFeatureEnabled,
} from '@google/adk';

overrideFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION, false);

createEnvironmentSimulationConfig();
// Error: Feature ENVIRONMENT_SIMULATION is not enabled.
```

Pass `undefined` as the second argument to clear the override.
