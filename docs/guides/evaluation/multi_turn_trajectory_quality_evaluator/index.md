# MultiTurnTrajectoryQualityV1Evaluator

`MultiTurnTrajectoryQualityV1Evaluator` scores the path an agent took across a
whole conversation. Reach for it when the agent reaches the goal, and you need
to grade the route it took to get there.

## Introduction

Multi-turn task success asks one question: did the agent reach the goal? This
metric asks a different one: how did it get there? A detour, a redundant step,
or a wrong ordering lowers the score even when the final answer is right. So
the two metrics disagree on the same conversation, and that disagreement is the
reason to run both.

The Vertex AI Gen AI evaluation service does the scoring, through its prebuilt
`MULTI_TURN_TRAJECTORY_QUALITY` rubric metric. Scores range over 0 to 1, and a
score closer to 1 is better. The metric is reference-free, so golden
invocations are optional.

The class holds a `MultiTurnVertexAiEvalFacade`, the facade that speaks to the
service, preconfigured with this one metric name. It implements the `Evaluator`
interface, so an eval harness holds it behind the same call as every other
metric. The `V1` suffix marks that a later version of the metric could use a
different strategy.

## Get started

The service has no JavaScript SDK, so you supply the transport and own
authentication. ADK reads no credentials for this metric.

```ts
import {
  EvalStatus,
  Invocation,
  MultiTurnTrajectoryQualityV1Evaluator,
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
    userContent: {parts: [{text: 'Book me a flight to Paris.'}]},
    finalResponse: {parts: [{text: 'Which date suits you?'}]},
  },
  {
    invocationId: 'inv2',
    userContent: {parts: [{text: 'Next Friday.'}]},
    finalResponse: {parts: [{text: 'Booked, flight AF1234.'}]},
  },
];

const evaluator = new MultiTurnTrajectoryQualityV1Evaluator({
  evalMetric: {
    metricName: PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
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
  metricName: PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
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

## Differences from adk-python

- `adk-python` builds a Vertex AI client from `GOOGLE_CLOUD_PROJECT` and
  `GOOGLE_CLOUD_LOCATION`. Here you supply the client, so ADK reads no
  credentials.
- `adk-python`'s `Evaluator` contract carries a third `conversation_scenario`
  argument, for metrics that grade how closely an agent followed a simulated
  user's plan. `adk-js` has no such metric yet, so its contract stops at the
  golden invocations. It is an optional argument, so a scenario-aware metric
  can add it back without breaking a caller.
- `adk-python` registers this evaluator in its metric evaluator registry, so an
  eval config naming `multi_turn_trajectory_quality_v1` resolves to it. Here it
  is not registered, because the registry seeds only metrics that need no
  injected client. Construct it yourself.
