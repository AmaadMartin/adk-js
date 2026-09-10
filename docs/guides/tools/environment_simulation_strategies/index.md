# Environment simulation mock strategies

A mock strategy answers a tool call with a simulated response, so an agent can
be exercised without the tool's real backend. Reach for it when the built-in
simulation rules are not enough, and you want to compute the response yourself.

## Introduction

`BaseMockStrategy` is the extension point. It has one method, `mock()`, which
receives the tool call and returns the object the model sees as the tool's
result. The class holds no connection, reads no credentials and makes no
network call of its own; whatever a subclass does is up to that subclass.

`MockRequest` carries everything the strategy gets. `tool`, `args` and
`toolContext` describe the call. `stateStore` is the simulated state shared
across one run: a strategy that simulates a creating tool records its response
there, so a later consuming call stays consistent with it. The object is
mutated in place. `toolConnectionMap`, `environmentData` and `tracing` are
optional, and describe the wider environment the call happens in.

Two classes ship here. `BaseMockStrategy` is `abstract` and declares `mock()`
abstract, so a subclass that forgets to implement it fails to compile rather
than at the first tool call. `TracingMockStrategy` is a placeholder: it carries
the model name and generation config a real implementation would use, and
always returns `{status: 'error', errorMessage: 'Not implemented'}`. adk-python
ships the same placeholder, and its simulation engine builds it for the
`MOCK_STRATEGY_TRACING` config value.

Construction requires the `ENVIRONMENT_SIMULATION` feature. The feature is off
by default, and constructing a strategy with it off throws
`Error('Feature ENVIRONMENT_SIMULATION is not enabled.')`.

## Get started

```ts
import {
  BaseMockStrategy,
  FeatureName,
  MockRequest,
  withTemporaryFeatureOverride,
} from '@google/adk';

class AlwaysSunnyStrategy extends BaseMockStrategy {
  override async mock(request: MockRequest): Promise<Record<string, unknown>> {
    return {
      status: 'ok',
      tool: request.tool.name,
      city: request.args['city'],
      forecast: 'sunny',
    };
  }
}

const response = await withTemporaryFeatureOverride(
  FeatureName.ENVIRONMENT_SIMULATION,
  true,
  async () => {
    const strategy = new AlwaysSunnyStrategy();
    return strategy.mock({
      tool: weatherTool,
      args: {city: 'Zurich'},
      toolContext,
      stateStore: {},
    });
  },
);
```

`withTemporaryFeatureOverride` restores the previous setting when the callback
finishes. To enable the feature for a whole process instead, set the
`ADK_ENABLE_ENVIRONMENT_SIMULATION` environment variable, or call
`overrideFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION, true)`.

## Keeping simulated calls consistent

`stateStore` is how one simulated call informs the next. Write to it under a
key the consuming call can find, and read it back before you invent a value.

```ts
class TicketStrategy extends BaseMockStrategy {
  override async mock(request: MockRequest): Promise<Record<string, unknown>> {
    if (request.tool.name === 'create_ticket') {
      request.stateStore['ticket_id'] = 'T-1';
      return {status: 'ok', ticketId: 'T-1'};
    }
    const ticketId = request.stateStore['ticket_id'];
    if (ticketId === undefined) {
      return {status: 'error', errorMessage: 'no ticket has been created'};
    }
    return {status: 'ok', ticketId};
  }
}
```

`toolConnectionMap` describes which tools create a shared parameter and which
consume it, so a strategy can decide which side of that pair it is on without
matching on tool names.
