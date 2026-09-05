# Multi-turn task success evaluator

`MultiTurnTaskSuccessV1Evaluator` scores whether an agent achieved the goal of
a whole conversation. Reach for it when the question is "did the booking get
made?" rather than "was each answer good?".

## Introduction

Most metrics score one answer at a time. A task can succeed over several turns
even when no single answer looks complete, and it can fail even when every
answer reads well. This evaluator asks the `MULTI_TURN_TASK_SUCCESS` rubric
metric of the Vertex AI Gen AI evaluation service to read every turn and return
one verdict for the conversation.

The class implements `Evaluator`, so it plugs in wherever a metric plugs in. It
is a thin adapter: it reads the threshold off the `EvalMetric` you construct it
with, and it delegates the work to `MultiTurnVertexAiEvalFacade`. The facade
maps each invocation onto one turn, in conversation order, with the events of a
turn running `[user, ...intermediate, agent]`, and it names the agents from
`invocation.appDetails.agentDetails`.

Because the service scores the conversation as a whole, one score comes back.
The evaluator puts that score on the last turn and marks every earlier turn
`NOT_EVALUATED`. Scores range over [0, 1], and a score closer to 1 is better.

The service has no JavaScript SDK. You supply a `VertexAiEvalClient` and you
own authentication, which needs a Google Cloud project. One test drives the
evaluator with a fake client and no network.

## Get started

Score a two-turn conversation:

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
    // Send `request` to the service, and return the summary metrics it
    // answers with.
    return {summaryMetrics: [{meanScore: 0.9}]};
  }
}

const evaluator = new MultiTurnTaskSuccessV1Evaluator({
  evalMetric: {
    metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
    criterion: {threshold: 0.8},
  },
  evalClient: new MyEvalClient(),
});

const conversation: Invocation[] = [
  {
    invocationId: 'inv1',
    userContent: {parts: [{text: 'book me a table'}]},
    finalResponse: {parts: [{text: 'for how many people?'}]},
  },
  {
    invocationId: 'inv2',
    userContent: {parts: [{text: 'four'}]},
    finalResponse: {parts: [{text: 'booked a table for four'}]},
  },
];

const result = await evaluator.evaluateInvocations(conversation);

result.overallScore; // 0.9
result.overallEvalStatus === EvalStatus.PASSED; // the score met the threshold
result.perInvocationResults[0].evalStatus === EvalStatus.NOT_EVALUATED;
result.perInvocationResults[1].evalStatus === EvalStatus.PASSED;
```

## Configure the threshold

The evaluator resolves the threshold in its constructor and keeps it. A score
at or above the threshold passes; a score below it fails.

Put the threshold on `criterion`. The metric-level `threshold` field is
deprecated, and the criterion wins when both are set:

```ts
new MultiTurnTaskSuccessV1Evaluator({
  evalMetric: {
    metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
    threshold: 0.5, // deprecated, and ignored here
    criterion: {threshold: 0.8},
  },
  evalClient: new MyEvalClient(),
});
```

Build the client's configuration from the environment with
`resolveVertexAiEvalClientConfig()`. It reads `GOOGLE_API_KEY`, or both
`GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`.

## Failure modes

- A metric that carries neither `criterion.threshold` nor `threshold` throws an
  `InputValidationError` from the constructor, before any request.
- `expectedInvocations` is optional. When you pass it, it must have the same
  length as `actualInvocations`; a mismatch throws an `InputValidationError`,
  and it throws before the empty-conversation check.
- An empty conversation sends no request and returns an unevaluated result.
- When the service returns no usable score, the whole evaluation reports
  `NOT_EVALUATED` with no per-invocation results. This discards the leading
  turns the facade had already built, and it matches `google/adk-python`.
- An error from your `VertexAiEvalClient` propagates unchanged.
- `evaluateInvocations` accepts a third `conversationScenario` argument and
  forwards it, because the `Evaluator` contract carries it. The facade ignores
  it today.
