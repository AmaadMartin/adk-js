# MultiTurnToolUseQualityV1Evaluator

`MultiTurnToolUseQualityV1Evaluator` scores the tool calls an agent made across
a whole conversation. Reach for it when a single turn looks correct on its own,
but the sequence of calls is what you need to grade.

## Introduction

A single-turn metric scores each turn in isolation. That misses the mistakes a
multi-turn agent actually makes: it calls the right tool at the wrong time, it
repeats a call it already made, or it never calls the tool the earlier turns set
up. This metric reads every turn and returns one score for the conversation.

The Vertex AI Gen AI evaluation service does the scoring, through its prebuilt
`MULTI_TURN_TOOL_USE_QUALITY` rubric metric. Scores range over 0 to 1, and a
score closer to 1 is better. The metric is reference-free, so golden
invocations are optional.

The class extends `MultiTurnVertexAiEvalFacade`, the facade that speaks to the
service, and preconfigures it with this one metric name. It implements the
`Evaluator` interface, so an eval harness holds it behind the same call as
every other metric. The `V1` suffix marks that a later version of the metric
could use a different strategy.

## Get started

The service has no JavaScript SDK, so you supply the transport and own
authentication. ADK reads no credentials for this metric.

```ts
import {
  EvalStatus,
  Invocation,
  MultiTurnToolUseQualityV1Evaluator,
  PrebuiltMetrics,
  VertexAiEvalClient,
  VertexAiEvalRequest,
  VertexEvaluationResult,
} from '@google/adk';

class MyEvalClient implements VertexAiEvalClient {
  async evaluate(
    request: VertexAiEvalRequest,
  ): Promise<VertexEvaluationResult> {
    // Send request.dataset and request.metrics to the service, then return
    // its summary metrics.
    return {summaryMetrics: [{meanScore: 0.9}]};
  }
}

const actual: Invocation[] = [
  {
    invocationId: 'inv1',
    userContent: {parts: [{text: 'What is the weather in Paris?'}]},
    finalResponse: {parts: [{text: 'It is 18 degrees.'}]},
  },
  {
    invocationId: 'inv2',
    userContent: {parts: [{text: 'And tomorrow?'}]},
    finalResponse: {parts: [{text: 'Rain, 15 degrees.'}]},
  },
];

const evaluator = new MultiTurnToolUseQualityV1Evaluator({
  evalMetric: {
    metricName: PrebuiltMetrics.MULTI_TURN_TOOL_USE_QUALITY_V1,
    criterion: {threshold: 0.8},
  },
  evalClient: new MyEvalClient(),
});
const result = await evaluator.evaluateInvocations(actual);

result.overallScore; // 0.9
result.overallEvalStatus === EvalStatus.PASSED;
```

## Configuring the threshold

The evaluator resolves the threshold once, when you construct it. A metric
carrying `criterion.threshold` wins over the deprecated metric-level
`threshold`.

```ts
// criterion.threshold wins, so this evaluator passes at 0.95 and above.
const evalMetric = {
  metricName: PrebuiltMetrics.MULTI_TURN_TOOL_USE_QUALITY_V1,
  threshold: 0.8,
  criterion: {threshold: 0.95},
};
```

A metric with neither field throws `InputValidationError` from the constructor,
before any request reaches the service.

## Reading the result

One conversation costs one request, and the score covers the conversation as a
whole. Only the last turn carries it: every earlier `PerInvocationResult` has
`score` undefined and `EvalStatus.NOT_EVALUATED`. `overallScore` is the last
turn's score, and `overallEvalStatus` applies the threshold to it.

When the service returns no numeric score, the result is `NOT_EVALUATED` with
an empty `perInvocationResults` list. An empty invocation list returns the same
result and sends no request.

Golden invocations are optional. When you pass them, the two lists must have
the same length, or the returned promise rejects with `InputValidationError`.

`evaluateInvocations` also accepts a `ConversationScenario`. This metric ignores
it; the parameter is on the shared `Evaluator` contract so that one caller
drives a scenario-aware metric and this one.

## Differences from adk-python

- `adk-python` builds a Vertex AI client from `GOOGLE_CLOUD_PROJECT` and
  `GOOGLE_CLOUD_LOCATION`. Here you supply the client, so ADK reads no
  credentials.
- `adk-python` requests the metric recipe at version `v1`. `VertexEvalMetricSpec`
  carries only a name, so the version is not sent and your client chooses the
  recipe.
- `adk-python` registers this evaluator in its metric evaluator registry. Here
  it is not registered, because the registry seeds only metrics that need no
  injected client. Construct it yourself.
