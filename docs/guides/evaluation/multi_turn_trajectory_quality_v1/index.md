# MultiTurnTrajectoryQualityV1Evaluator

`MultiTurnTrajectoryQualityV1Evaluator` scores the path an agent took across a
whole conversation. Reach for it when a suite must catch a detour, a redundant
tool call or a backtrack, even on a run that reached the goal.

## Introduction

Multi-turn task success asks one question: did the agent get there? This metric
asks how. Two runs can both book the flight, and only one of them calls the
search tool four times to do it. The Vertex AI Gen AI evaluation service reads
every turn, scores the conversation as a whole, and returns one score in the
range 0 to 1. A score closer to 1 is better.

This is a reference-free metric, so golden invocations are optional. The class
implements the `Evaluator` interface, so a harness holds it next to
`SafetyEvaluatorV1` behind the same call. It holds no scoring logic of its own:
it resolves the threshold, then delegates to `MultiTurnVertexAiEvalFacade`,
which asks the service for its prebuilt `MULTI_TURN_TRAJECTORY_QUALITY` metric.
The `V1` suffix marks that a later version could use a different strategy.

## Get started

The service has no JavaScript SDK, so you supply the transport and own
authentication. ADK reads no credentials for this metric.

```ts
import {
  EvalStatus,
  Invocation,
  MultiTurnTrajectoryQualityV1Evaluator,
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
    userContent: {parts: [{text: 'Book me a flight to LAX.'}]},
    finalResponse: {parts: [{text: 'Which day works for you?'}]},
  },
  {
    userContent: {parts: [{text: 'Next Tuesday morning.'}]},
    finalResponse: {parts: [{text: 'Booked, 08:15 SFO to LAX.'}]},
  },
];

const evaluator = new MultiTurnTrajectoryQualityV1Evaluator({
  evalMetric: {
    metricName: 'multi_turn_trajectory_quality_v1',
    criterion: {threshold: 0.8},
  },
  evalClient: new MyEvalClient(),
});
const result = await evaluator.evaluateInvocations(actual);

result.overallScore; // 0.9
result.overallEvalStatus === EvalStatus.PASSED;
```

## What the request carries

One conversation costs one request, whatever the turn count. The facade maps
the invocations onto `dataset.evalCases`, not the `dataset.evalDataset` a
single-turn metric uses. Each turn becomes a list of events: the user message,
then the intermediate events of `intermediateData`, then the final response.
An invocation's `appDetails.agentDetails` supplies the agents, and the first
turn that names an agent describes it.

## Configuring the threshold

The evaluator resolves the threshold once, when you construct it. A metric
carrying `criterion.threshold` wins over the deprecated metric-level
`threshold`.

```ts
// criterion.threshold wins, so this evaluator passes at 0.95 and above.
const evalMetric = {
  metricName: 'multi_turn_trajectory_quality_v1',
  threshold: 0.8,
  criterion: {threshold: 0.95},
};
```

A metric with neither field throws `InputValidationError` from the constructor,
before any request reaches the service.

## Reading the result

The service scores the conversation, not the turn, so only the last
`PerInvocationResult` carries a score. Every earlier turn comes back with
`score` undefined and `EvalStatus.NOT_EVALUATED`. `overallScore` is that one
score, and `overallEvalStatus` applies your threshold to it.

A conversation the service did not score returns the empty result:
`overallScore` undefined, `overallEvalStatus` `NOT_EVALUATED` and no
per-invocation results. An empty invocation list returns the same and sends no
request.

Golden invocations are optional. When you pass them, the two lists must have
the same length, and each golden turn is echoed into its `PerInvocationResult`.
A length mismatch rejects the returned promise with `InputValidationError`,
before any request is sent.

## Differences from adk-python

- `adk-python` builds a Vertex AI client from `GOOGLE_CLOUD_PROJECT` and
  `GOOGLE_CLOUD_LOCATION`. Here you supply the client, so ADK reads no
  credentials.
- `adk-python` pins the metric to `version='v1'` alongside its name. The
  request type here carries only a name, so no version is sent.
- `evaluateInvocations` accepts a `conversationScenario` and forwards it to the
  facade, which ignores it. Both SDKs derive what they need from the turns.
