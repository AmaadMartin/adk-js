# Environment simulation

Answers a tool call from a fake environment instead of calling the tool. Reach
for it when you want to exercise an agent against a backend you do not have, or
against failures the real backend will not produce on demand.

## Introduction

An environment simulation intercepts a tool call before the tool runs and
returns a fabricated response. The agent cannot tell the difference, so the
turn proceeds exactly as it would against the real backend.

Two mechanisms produce that response, tried in order:

- **Injection rules** fire first. A rule returns a canned error or a canned
  response body, optionally only for calls whose arguments match, optionally
  after added latency, and optionally only some of the time.
- **A mock strategy** handles the calls no rule fired on.
  `MOCK_STRATEGY_TOOL_SPEC` asks a model to invent a plausible response from
  the tool's own declaration.

The two split the work cleanly. Use an injection rule when you know the exact
answer you want, and a mock strategy when you want a plausible one you did not
have to write.

`EnvironmentSimulationConfig` describes the simulation, and you build it with
`createEnvironmentSimulationConfig`. `EnvironmentSimulationFactory` turns that
description into one of two things you can attach to a run:

- `createCallback(config)` returns a before-tool callback for one agent.
- `createPlugin(config)` returns a plugin for a whole runner.

Both build one engine and share it, so the entities the simulation creates stay
visible for the rest of the run.

## Get started

```ts
import {
  EnvironmentSimulationFactory,
  FunctionTool,
  LlmAgent,
  createEnvironmentSimulationConfig,
} from '@google/adk';

const getTicketTool = new FunctionTool({
  name: 'getTicket',
  description: 'Reads a ticket from the ticketing system.',
  execute: async (args: {ticketId: string}) => readTicket(args.ticketId),
});

const config = createEnvironmentSimulationConfig({
  toolSimulationConfigs: [
    {
      toolName: 'getTicket',
      injectionConfigs: [
        {
          matchArgs: {ticketId: 'missing'},
          injectedError: {
            injectedHttpErrorCode: 404,
            errorMessage: 'no such ticket',
          },
        },
      ],
    },
  ],
});

const agent = new LlmAgent({
  name: 'support',
  model: 'gemini-2.5-flash',
  tools: [getTicketTool],
  beforeToolCallback: EnvironmentSimulationFactory.createCallback(config),
});
```

A call to `getTicket` with `{ticketId: 'missing'}` now returns
`{errorCode: 404, errorMessage: 'no such ticket'}` and the real tool never
runs. A call with any other `ticketId` does not match the rule, so the real
tool runs as usual.

To simulate the tools of every agent in a run, attach a plugin instead:

```ts
import {InMemoryRunner} from '@google/adk';

const runner = new InMemoryRunner({
  appName: 'support_app',
  agent,
  plugins: [EnvironmentSimulationFactory.createPlugin(config)],
});
```

## What a rule matches

`matchArgs` names the entries a call must carry, not the whole argument object.
A rule that names one argument still fires on a call that passes several:

```ts
{
  matchArgs: {
    query: 'cats';
  }
}
// fires on {query: 'cats', limit: 10}
// does not fire on {query: 'dogs'} or on {limit: 10}
```

Values are compared structurally, so `matchArgs: {filter: {a: 1}}` fires on a
call that passes an equal object. Omit `matchArgs` to fire on every call.

The rules of a tool are tried in order, and the first one that fires wins.

## Making a rule fire only sometimes

`injectionProbability` is the chance a rule fires, and defaults to 1. The engine
draws a number in `[0, 1)` and the rule fires when the draw is below the
probability. A draw equal to the probability does not fire.

Set `randomSeed` to make a rule reproducible. The seed reseeds the engine's one
generator, so it also fixes the draws of the rules after it and of later calls.
Two engines built from the same seeded config make the same decisions.

`injectedLatencySeconds` adds a real wait before the injected value comes back,
which is how you reproduce a slow backend. It may not exceed 120 seconds.

## Mocking a response from the tool declaration

When no rule fires, the tool's `mockStrategyType` decides what happens:

- `MOCK_STRATEGY_UNSPECIFIED`, the default, logs a warning and lets the real
  tool run.
- `MOCK_STRATEGY_TOOL_SPEC` asks the simulation model to invent a response.
- `MOCK_STRATEGY_TRACING` is deprecated. It returns
  `{status: 'error', errorMessage: 'Not implemented'}`. Pass the trace as
  `tracing` on the config and use `MOCK_STRATEGY_TOOL_SPEC` instead.

`MOCK_STRATEGY_TOOL_SPEC` keeps the simulation consistent across calls. Before
the first mocked call, the engine asks the model which parameters carry state
between the configured tools — that a `create_ticket` produces a ticket id and
a `get_ticket` reads one. It then records every entity a creating tool invents,
and passes those entities to later calls, so a consuming tool sees the id its
creating tool returned.

```ts
const config = createEnvironmentSimulationConfig({
  toolSimulationConfigs: [
    {
      toolName: 'create_ticket',
      mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
    },
    {
      toolName: 'get_ticket',
      mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
    },
  ],
  environmentData: '{"tickets": []}',
});
```

`environmentData` and `tracing` are two optional JSON strings the mock prompt
carries in their own sections: a snapshot of the environment to answer from,
and a trace of a prior run to stay consistent with.

The analysis runs at most once per engine, and only when some configured tool
asks for a mock strategy. An agent that is not an `LlmAgent` has no tool list to
analyze, so the engine marks the analysis done and does not retry it.

## Which model the simulation calls

`simulationModel` defaults to `gemini-2.5-flash`, and
`simulationModelConfiguration` configures those calls. The simulation resolves
the model on first use, so an injection-only simulation needs no credentials at
all.

The mock strategy and the analyzer both ask for `application/json`, folded into
the configuration you supply.

## Failure modes

A simulation answers with an error object rather than breaking the turn, in
every case below.

| Situation                                       | What happens                                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| The tool is not in the config                   | The real tool runs.                                                                            |
| No rule fired and the tool has no mock strategy | A warning names the tool, and the real tool runs.                                              |
| The tool has no declaration                     | `{status: 'error', errorMessage: 'Could not get tool declaration.'}`                           |
| The model's answer is not JSON                  | `{status: 'error', errorMessage: 'Failed to generate valid JSON mock response.', llmOutput}`   |
| The model's answer is JSON but not an object    | `{status: 'error', errorMessage: 'Generated mock response was not a JSON object.', llmOutput}` |
| The analysis cannot be read                     | A warning, and mocking continues without stateful consistency.                                 |

Two things do throw, both out of `simulate` and into the tool call. A
`simulationModel` that no registry entry matches is a configuration error, and
it surfaces on the first call that needs the model. A model call that fails —
a rate limit, a network error — propagates as the model client raised it,
because nothing here retries or swallows it. adk-python behaves the same way.

Both the analyzer and the mock strategy strip a Markdown code fence before
parsing, because a model asked for raw JSON often wraps it in one.

## Turning the feature off

Environment simulation is gated by the experimental `ENVIRONMENT_SIMULATION`
feature, which is on by default. The config factories throw when it is off, so
nothing downstream of them can run. Set
`ADK_DISABLE_ENVIRONMENT_SIMULATION=true` in the environment, or call
`overrideFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION, false)` from inside
the process.
