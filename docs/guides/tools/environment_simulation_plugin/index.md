# Environment simulation plugin

Routes every tool call an agent makes through a simulator instead of the real
tool. Reach for it when you want to exercise an agent against canned results,
injected errors or injected latency, without calling the live service behind
each tool.

## Introduction

`EnvironmentSimulationPlugin` is a `BasePlugin` that overrides one hook,
`beforeToolCallback`. On every tool call it asks a simulator for a result. The
simulator answers in one of two ways:

- **A record.** That record becomes the tool's result. The real tool never
  runs, and the rest of the plugin chain is skipped, because `PluginManager`
  returns on the first plugin that answers.
- **`undefined`.** Nothing is simulated. The chain continues and the real tool
  runs as usual.

So one plugin instance can simulate some tools and leave the others live, and
the decision is the simulator's, per call. The plugin itself holds no
configuration, inspects nothing and logs nothing.

The simulator is anything that satisfies `ToolCallSimulator`, a single-method
interface. adk-python passes its `EnvironmentSimulationEngine` here, which asks
a model to invent a plausible response from the tool's own declaration. That
engine is a separate module and is not in adk-js yet, so today you supply the
simulator yourself.

The plugin is experimental and is gated on the `ENVIRONMENT_SIMULATION`
feature. The feature is on by default, matching adk-python.

## Get started

```ts
import {
  App,
  BaseTool,
  Context,
  EnvironmentSimulationPlugin,
  FunctionTool,
  LlmAgent,
  ToolCallSimulator,
} from '@google/adk';
import {z} from 'zod';

const getWeather = new FunctionTool({
  name: 'get_weather',
  description: 'Returns the weather of a city.',
  parameters: z.object({city: z.string()}),
  execute: async ({city}) => ({city, conditions: 'live service'}),
});

class WeatherSimulator implements ToolCallSimulator {
  async simulate(
    tool: BaseTool,
    args: Record<string, unknown>,
    _toolContext: Context,
  ): Promise<Record<string, unknown> | undefined> {
    if (tool.name !== 'get_weather') {
      return undefined; // Run the real tool.
    }
    return {city: args['city'], conditions: 'sunny, 21C'};
  }
}

export const app = new App({
  name: 'weather_simulation',
  rootAgent: new LlmAgent({
    name: 'weather_agent',
    model: 'gemini-2.5-flash',
    instruction: 'Answer weather questions. Call get_weather.',
    tools: [getWeather],
  }),
  plugins: [new EnvironmentSimulationPlugin(new WeatherSimulator())],
});
```

The agent now answers from `sunny, 21C` and never reaches the live service.

## Failure modes

**The simulator rejects.** The rejection propagates out of the hook. The real
tool does not run as a fallback: a failed simulation must not quietly call the
live service, which is the one thing a simulated run is meant to prevent.
`PluginManager` wraps the rejection in an `Error` naming the plugin and the
callback.

**The feature is disabled.** The constructor throws
`Feature ENVIRONMENT_SIMULATION is not enabled.` Disable the feature with the
`ADK_DISABLE_ENVIRONMENT_SIMULATION` environment variable, or with
`overrideFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION, false)`.

**Another plugin answers first.** Plugins run in registration order, so a
plugin registered before this one can answer a tool call and the simulator is
never asked. Register the simulation plugin first if it must see every call.
