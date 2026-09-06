# MultiTurnTaskSuccessV1Evaluator

`MultiTurnTaskSuccessV1Evaluator` answers one question about a whole
conversation: did the agent achieve what the user came for? Reach for it when
a task spans several turns, and grading each answer on its own would miss the
point.

## Introduction

A single-turn metric scores one reply against one prompt. That is the wrong
shape for a booking flow, where turn 3 is only correct because turn 2 asked
for a date. `MultiTurnTaskSuccessV1Evaluator` sends the whole conversation to
the Vertex AI Gen AI evaluation service and asks for its
`MULTI_TURN_TASK_SUCCESS` rubric metric. The service returns one score in the
range 0 to 1, and a score closer to 1 means the agent completed the task.

The class implements the `Evaluator` interface, so an eval harness holds it
behind the same call as every other metric. It holds no scoring logic: it
resolves the threshold once, then delegates to `MultiTurnVertexAiEvalFacade`,
which sends exactly one request per call however long the conversation is. The
`V1` suffix marks that a later task-success metric could use a different
strategy.

The metric is reference-free, so golden invocations are optional.

## Get started

The service has no JavaScript SDK, so you supply the transport and own
authentication. ADK reads no credentials for this metric.

```ts
import {
  EvalStatus,
  Invocation,
  MultiTurnTaskSuccessV1Evaluator,
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

const conversation: Invocation[] = [
  {
    invocationId: 'inv1',
    userContent: {parts: [{text: 'I need to book a flight.'}]},
    finalResponse: {parts: [{text: 'Where would you like to go?'}]},
  },
  {
    invocationId: 'inv2',
    userContent: {parts: [{text: 'San Francisco, next Tuesday.'}]},
    finalResponse: {parts: [{text: 'Booked: SFO, Tuesday 09:00.'}]},
  },
];

const evaluator = new MultiTurnTaskSuccessV1Evaluator({
  evalMetric: {
    metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
    criterion: {threshold: 0.8},
  },
  evalClient: new MyEvalClient(),
});
const result = await evaluator.evaluateInvocations(conversation);

result.overallScore; // 0.9
result.overallEvalStatus === EvalStatus.PASSED;
```

To reach the real service, your client needs a Google Cloud project. Set
`GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`, and read them in the client
you write; ADK does not read them for you.

## Configuring the threshold

The evaluator resolves the threshold once, when you construct it. A metric
carrying `criterion.threshold` wins over the deprecated metric-level
`threshold`.

```ts
// criterion.threshold wins, so this evaluator passes at 0.95 and above.
const evalMetric = {
  metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
  threshold: 0.8,
  criterion: {threshold: 0.95},
};
```

A metric with neither field throws `InputValidationError` from the
constructor, before any request reaches the service.

## Reading the result

The service scores the conversation, not the individual turns, so the score
lands on the last turn. `perInvocationResults` holds one entry per invocation
you passed, in order. Every turn but the last carries an undefined `score` and
`EvalStatus.NOT_EVALUATED`. The last turn carries the score the service
returned. `overallScore` is that same score, and the conversation passes when
it is greater than or equal to the threshold.

What the request carries: one eval case, holding the agents your invocations
declared in `appDetails.agentDetails`, and one turn per invocation. Each turn
maps to the events `[user, ...intermediateData.invocationEvents, agent]`, and
its `turnId` is the `invocationId`. An agent that several turns declare is
described by the first turn that declares it.

Two cases produce no verdict:

- An empty invocation list returns `NOT_EVALUATED` and sends no request.
- A conversation the service did not score returns `NOT_EVALUATED` with an
  empty `perInvocationResults`. The per-turn results are discarded rather than
  reported unscored, matching adk-python.

Golden invocations are optional. When you pass them, the two lists must have
the same length, and each result is paired with the golden invocation at its
index. A length mismatch rejects the returned promise with
`InputValidationError`.

## Differences from adk-python

- `adk-python` builds a Vertex AI client from `GOOGLE_API_KEY`, or from
  `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`. Here you supply the
  client, so ADK reads no credentials.
- `adk-python`'s `evaluate_invocations` is synchronous.
  `evaluateInvocations` returns a promise.
- `adk-python` raises `ValueError` where this throws
  `InputValidationError`.
