# Environment simulation

Environment simulation answers a tool call from a script or from a model
instead of running the tool. Reach for it when you want to exercise an agent's
tool-calling behaviour without a live back-end, or when you want a specific
tool to fail on demand.

## Introduction

An agent that calls tools is hard to test end to end. The tools need real
credentials and real services, and a failure you care about — a 503 from a
payment gateway, a timeout on a slow call — is hard to produce on purpose.

Environment simulation intercepts the call before the tool runs and returns a
simulated result. It offers two mechanisms, in this order:

- **Injection.** Each tool carries an ordered list of rules. A rule can match on
  argument values, fire with a probability, be pinned by a random seed, and add
  latency. It then returns either an injected error or an injected response
  body. The first rule that fires wins.
- **Mock strategy.** When no rule fires, an optional strategy asks a model to
  invent a plausible JSON response from the tool's own function declaration. It
  also asks the model which parameters carry state between tools, so an
  identifier that `create_ticket` mints is honoured by `get_ticket` later in the
  same run.

A tool with no configuration is untouched, and runs normally.

This is not a policy gate. `SecurityPlugin` decides whether a call is allowed;
environment simulation decides what a call returns. The two are independent and
can be registered together.

## Get started

Attach the simulation to one agent with `createEnvironmentSimulationCallback`:

```typescript
import {
  createEnvironmentSimulationCallback,
  FunctionTool,
  LlmAgent,
  MockStrategyType,
} from '@google/adk';
import {z} from 'zod';

const createTicket = new FunctionTool({
  name: 'create_ticket',
  description: 'Opens a support ticket.',
  parameters: z.object({title: z.string()}),
  execute: async ({title}) => {
    const response = await fetch('https://tickets.example.com/api/tickets', {
      method: 'POST',
      body: JSON.stringify({title}),
    });
    return response.json();
  },
});

const agent = new LlmAgent({
  name: 'support',
  model: 'gemini-2.5-flash',
  tools: [createTicket],
  beforeToolCallback: createEnvironmentSimulationCallback({
    toolSimulationConfigs: [
      {
        toolName: 'create_ticket',
        mockStrategyType: MockStrategyType.MOCK_STRATEGY_TOOL_SPEC,
      },
    ],
  }),
});
```

Use `EnvironmentSimulationPlugin` instead to apply the same simulation to every
agent a runner drives:

```typescript
import {EnvironmentSimulationPlugin, InMemoryRunner} from '@google/adk';

const runner = new InMemoryRunner({
  agent,
  plugins: [new EnvironmentSimulationPlugin(config)],
});
```

Each owns one engine, and that engine holds the identifiers the tools mint. So
build the callback or the plugin once and reuse it: a second one starts with an
empty state store.

## Injecting a failure

An injection rule returns an error payload in place of the tool result. The
payload reaches the model as `error_code` and `error_message`.

```typescript
const config = {
  toolSimulationConfigs: [
    {
      toolName: 'charge_card',
      injectionConfigs: [
        {
          matchArgs: {currency: 'JPY'},
          injectedError: {
            injectedHttpErrorCode: 503,
            errorMessage: 'upstream down',
          },
        },
        {
          injectionProbability: 0.1,
          injectedLatencySeconds: 2,
          injectedResponse: {status: 'ok', authorized: true},
        },
      ],
      mockStrategyType: MockStrategyType.MOCK_STRATEGY_TOOL_SPEC,
    },
  ],
};
```

`matchArgs` compares by value, so an array or an object matches on its
contents. A rule with a `randomSeed` draws from that seed, which makes its
decision repeatable and affects no other rule. A rule without one draws from
`Math.random()`.

## Configuration

| Field                          | Default                    | Meaning                                                   |
| ------------------------------ | -------------------------- | --------------------------------------------------------- |
| `toolSimulationConfigs`        | required                   | The tools to simulate. Names must be unique.              |
| `simulationModel`              | `gemini-2.5-flash`         | The model the simulator calls itself.                     |
| `simulationModelConfiguration` | thinking off, budget 10240 | The configuration of those calls.                         |
| `environmentData`              | unset                      | Environment data, such as a small database dump, as JSON. |
| `tracing`                      | unset                      | A prior agent run trace, as JSON.                         |

`environmentData` and `tracing` are passed to the mock strategy, which puts
them in the prompt so the invented responses stay consistent with them.

The constructor validates the config and throws on:

- a tool with neither an injection rule nor a mock strategy;
- an injection rule that sets both `injectedError` and `injectedResponse`, or
  neither;
- an `injectedLatencySeconds` above 120;
- an empty `toolSimulationConfigs`, or a repeated `toolName`.

## Failure modes

Model output is untrusted, so the simulator degrades rather than failing the
run:

- The connection analysis proceeds without a map when the model answers with
  something other than the documented JSON. It logs a warning.
- A mock returns `{status: 'error', error_message: ...}` when the tool has no
  declaration, when the model's reply is not JSON, or when it is JSON but not
  an object. The last two carry the raw reply in `llm_output`.
- `MOCK_STRATEGY_TRACING` is deprecated and returns
  `{status: 'error', error_message: 'Not implemented'}`. Use
  `MOCK_STRATEGY_TOOL_SPEC` with `tracing` instead.

The state store grows with every entity a creating tool mints, and it has no
eviction. Keep one engine per run rather than one per process.
