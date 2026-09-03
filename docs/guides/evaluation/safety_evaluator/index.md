# SafetyEvaluatorV1

`SafetyEvaluatorV1` scores how harmless an agent's answer is. Reach for it when
your eval suite must catch unsafe replies, and you have no golden answer to
compare against.

## Introduction

Most response metrics need a golden answer. Safety does not. The Vertex AI Gen
AI evaluation service reads the prompt and the reply, and returns one score in
the range 0 to 1. A score closer to 1 is safer. `SafetyEvaluatorV1` asks the
service for its prebuilt `SAFETY` metric and applies your threshold to the
result.

The class implements the `Evaluator` interface, so an eval harness can hold it
next to `ResponseEvaluator` behind the same call. It holds no scoring logic of
its own: it resolves the threshold, then delegates to
`SingleTurnVertexAiEvalFacade`, which sends one request per invocation. The
`V1` suffix marks that a later safety metric could use a different strategy.

## Get started

The service has no JavaScript SDK, so you supply the transport and own
authentication. ADK reads no credentials for this metric.

```ts
import {
  EvalStatus,
  Invocation,
  SafetyEvaluatorV1,
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
    invocationId: '',
    userContent: {parts: [{text: 'Tell me a joke.'}]},
    finalResponse: {parts: [{text: 'Why did the chicken cross the road?'}]},
    creationTimestamp: 0,
  },
];

const evaluator = new SafetyEvaluatorV1({
  evalMetric: {metricName: 'safety_v1', criterion: {threshold: 0.8}},
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
  metricName: 'safety_v1',
  threshold: 0.8,
  criterion: {threshold: 0.95},
};
```

A metric with neither field throws `InputValidationError` from the
constructor, before any request reaches the service.

## Reading the result

`evaluateInvocations` returns one `PerInvocationResult` for every invocation
you passed, in order. An invocation passes when its score is greater than or
equal to the threshold. `overallScore` is the mean of the scores, and
`overallEvalStatus` applies the same threshold to that mean.

An invocation the service did not score keeps `score` undefined and gets
`EvalStatus.NOT_EVALUATED`. It is left out of the mean. An empty invocation
list returns `NOT_EVALUATED` and sends no request.

Golden invocations are optional. When you pass them, the two lists must have
the same length, and each golden final response travels to the service as the
row's `reference`. A length mismatch rejects the returned promise with
`InputValidationError`.

## Differences from adk-python

- `adk-python` builds a Vertex AI client from `GOOGLE_CLOUD_PROJECT` and
  `GOOGLE_CLOUD_LOCATION`. Here you supply the client, so ADK reads no
  credentials.
- `adk-python`'s `evaluate_invocations` accepts a `conversation_scenario` and
  discards it. The `Evaluator` interface here has no such parameter.
