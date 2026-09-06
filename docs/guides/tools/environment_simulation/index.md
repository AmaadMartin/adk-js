# Environment simulation

Serves an agent's tool calls from a simulated environment instead of the real
backend. Reach for it when you want to test an agent against a tool that fails,
a tool that is not built yet, or a tool you must not call for real.

## Introduction

`EnvironmentSimulationFactory` turns an `EnvironmentSimulationConfig` into
something an agent runs. It gives you two forms of the same thing:

- `createCallback(config)` returns a `beforeToolCallback` for one agent.
- `createPlugin(config)` returns a plugin, which the runner applies to every
  agent in the run.

Both intercept a tool call before it happens. A tool the config does not name
is never intercepted, so the real tool runs. A tool the config does name is
answered by the simulation, and the real function never executes.

The answer comes from one of two mechanisms, tried in that order:

- **Injection rules** return a canned error or a canned response body. They
  make no model call.
- **A mock strategy** answers the calls no rule fired on.
  `MOCK_STRATEGY_TOOL_SPEC` asks a model to invent a response from the tool's
  own declaration.

Each factory call builds one engine, and the returned callback closes over it.
That engine is where the simulation keeps its state: the tool connection
analysis it ran once, and the entities the mocked calls created. Reuse the
callback across the whole run. Building a new one per tool call throws that
state away, and the mocking stops being consistent with itself.

## Get started

```ts
import {
  EnvironmentSimulationFactory,
  LlmAgent,
  MockStrategy,
  createEnvironmentSimulationConfig,
  createInjectedError,
  createInjectionConfig,
  createToolSimulationConfig,
} from '@google/adk';

const config = createEnvironmentSimulationConfig({
  toolSimulationConfigs: [
    // Every call to get_weather returns this 404.
    createToolSimulationConfig({
      toolName: 'get_weather',
      injectionConfigs: [
        createInjectionConfig({
          injectedError: createInjectedError({
            injectedHttpErrorCode: 404,
            errorMessage: 'City not found.',
          }),
        }),
      ],
    }),
    // A model invents create_ticket's response from its declaration.
    createToolSimulationConfig({
      toolName: 'create_ticket',
      mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
    }),
  ],
});

const agent = new LlmAgent({
  name: 'support_agent',
  model: 'gemini-flash-latest',
  tools: [getWeather, createTicket],
  beforeToolCallback: EnvironmentSimulationFactory.createCallback(config),
});
```

A runnable version of this agent is in
`samples/tools/environment_simulation/agent.ts`.

To simulate the tools of every agent in a run, pass a plugin to the runner
instead:

```ts
import {EnvironmentSimulationFactory, Runner} from '@google/adk';

const runner = new Runner({
  appName: 'support',
  agent,
  sessionService,
  plugins: [EnvironmentSimulationFactory.createPlugin(config)],
});
```

## What a simulated call returns

The value reaches the model as the tool result. Its keys are snake_case,
because the model reads them, and adk-python spells them that way:

| Case                              | Result                                 |
| --------------------------------- | -------------------------------------- |
| Tool not named in the config      | nothing, so the real tool runs         |
| An injection rule with an error   | `{error_code, error_message}`          |
| An injection rule with a response | that response body                     |
| `MOCK_STRATEGY_TOOL_SPEC`         | the object the model generated         |
| No rule fired, no mock strategy   | nothing, and a warning naming the tool |

## Injection rules are tried in order

The first rule that both matches the call and wins its probability draw answers
it. No later rule runs.

`matchArgs` is a subset test. A call that carries extra arguments still
matches; a call that omits one of the keys, or carries a different value for
it, does not:

```ts
createInjectionConfig({
  matchArgs: {city: 'Munich'},
  injectedResponse: {conditions: 'foggy'},
});

// {city: 'Munich', unit: 'C'} matches.
// {city: 'Berlin'} does not. {unit: 'C'} does not.
```

`injectionProbability` decides how often a matching rule fires; it defaults to
1, so a rule fires on every call. `randomSeed` makes that draw reproducible.
adk-python seeds CPython's Mersenne Twister, and JavaScript has no seedable
`Math.random`, so adk-js seeds its own generator. The same seed always makes
the same decision, but the decision a given seed makes differs between the two
SDKs.

`injectedLatencySeconds` delays the answer. The call waits before the injected
value comes back.

## Stateful mocking

`MOCK_STRATEGY_TOOL_SPEC` is more than a per-call mock. On the first simulated
call, the engine asks a model which parameters carry state between the agent's
tools: which tools create a `ticket_id`, and which tools read one. It runs that
analysis once per engine and caches the result.

After that, a mocked call to a creating tool records what it produced, keyed by
the parameter value. A later call sees those entities in its prompt, so a tool
that reads an id can answer with the entity the tool that created it returned.

The analysis needs an `LlmAgent` on the invocation to list the tools. When the
running agent is not one, the engine skips the analysis and mocks without a
connection map. It does not retry.

An analysis costs one model call, so it only runs when some configured tool
asks for a mock strategy. A configuration that only injects responses makes no
model call at all, and never resolves a model.

## Failure modes

None of these throws. A simulation that cannot answer degrades instead:

- A model answer the analyzer cannot read becomes an empty connection map, and
  a warning. Stateful mocking is lost; the run continues.
- A tool with no declaration cannot be mocked from its specification, so the
  strategy answers `{status: 'error', error_message: 'Could not get tool
declaration.'}`.
- A model answer that is not a JSON object becomes an `{status, error_message,
llm_output}` object, carrying the raw text so you can see what the model
  said.

`MOCK_STRATEGY_TRACING` is a stub in adk-python and a stub here: it answers
`{status: 'error', error_message: 'Not implemented'}`. Use
`MOCK_STRATEGY_TOOL_SPEC` with `tracing` set on the config instead.

## The feature flag

The whole feature sits behind `FeatureName.ENVIRONMENT_SIMULATION`, which is
experimental and on by default. `createCallback` and `createPlugin` throw when
it is off, so a hand-built config cannot reach the engine past the flag.
