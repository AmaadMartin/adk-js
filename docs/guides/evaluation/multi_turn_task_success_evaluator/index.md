# MultiTurnTaskSuccessV1Evaluator

`MultiTurnTaskSuccessV1Evaluator` answers one question about a conversation:
did the agent achieve what the user came for? It sends every turn to the
`MULTI_TURN_TASK_SUCCESS` rubric metric of the Vertex AI Gen AI evaluation
service and reports one score for the conversation. Reach for it when the goal
spans several turns, such as a booking flow or a support ticket.

## Introduction

Most evaluators in ADK score one turn at a time. A per-turn metric grades each
reply on its own, so it cannot tell you whether the flight was booked. It also
misreads a turn that is only correct because of an earlier one: an agent that
answers "Tuesday at 09:15" looks wrong until you read the turn where the user
named the date.

This metric reads the conversation as a unit. The score reflects the task, not
the wording of any single reply.

The metric is reference free. You do not need golden invocations, because the
service judges task success against a rubric instead of against a recorded
answer. You may still pass expected invocations; they are paired with the
actual ones in `perInvocationResults` and are reported back untouched.

`MultiTurnVertexAiEvalFacade` is the general facade over a multi-turn metric of
the service. This class is the preconfigured form of it: it pins the metric
name and resolves the threshold once. Use the facade directly for a multi-turn
metric that has no evaluator of its own.

The service has no JavaScript SDK. You write the transport yourself as a
`VertexAiEvalClient`, and you own authentication; the evaluator never reads the
environment.

## Get started

```ts
import {
  EvalStatus,
  Invocation,
  MultiTurnTaskSuccessV1Evaluator,
  PrebuiltMetrics,
  VertexAiEvalClient,
} from '@google/adk';

// Your transport to the evaluation service.
declare const evalClient: VertexAiEvalClient;

const evaluator = new MultiTurnTaskSuccessV1Evaluator({
  evalMetric: {
    metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
    criterion: {threshold: 0.8},
  },
  evalClient,
});

const conversation: Invocation[] = [
  {
    invocationId: 'inv1',
    userContent: {parts: [{text: 'Book me a flight to LAX next Tuesday.'}]},
    finalResponse: {parts: [{text: 'Which airport do you leave from?'}]},
  },
  {
    invocationId: 'inv2',
    userContent: {parts: [{text: 'SFO.'}]},
    finalResponse: {parts: [{text: 'Booked: SFO to LAX, Tuesday 09:15.'}]},
  },
];

const result = await evaluator.evaluateInvocations(conversation);

if (result.overallEvalStatus === EvalStatus.PASSED) {
  // result.overallScore holds the score the service returned.
}
```

## Resolving the threshold

The constructor reads the threshold once, through `getMetricThreshold`. A
`criterion.threshold` wins over the deprecated metric-level `threshold`. A
metric that carries neither is a configuration error, so the constructor throws
`InputValidationError` with the message
`Evaluation metric '<name>' requires a threshold.` The evaluator holds no
mutable state after that, so one instance grades any number of conversations.

## What the result holds

`evaluateInvocations` returns an `EvaluationResult`:

- `overallScore` is the score the service returned for the conversation, in
  `[0, 1]`, or `undefined` when it returned none.
- `overallEvalStatus` is `PASSED` when the score reaches the threshold,
  `FAILED` when it does not, and `NOT_EVALUATED` when there is no score.
- `perInvocationResults` carries one entry per turn, in order. The service
  scores the conversation as a whole, so only the last turn carries the score
  and every earlier turn is `NOT_EVALUATED`.

One conversation costs exactly one request, whatever the number of turns.

An empty conversation sends no request and comes back `NOT_EVALUATED` with an
empty `perInvocationResults`. A conversation the service returned no score for
comes back the same way: the per-turn results are discarded, which is what
adk-python does.

## Failure modes

- Actual and expected invocation lists of different lengths are rejected with
  `InputValidationError`, before any request reaches the service.
- A rejection from your client propagates unchanged. The evaluator does not
  retry it, wrap it, or swallow it.

## Divergence from adk-python

adk-python builds a `vertexai.Client` inside the facade, from `GOOGLE_API_KEY`
or from `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`. There is no
JavaScript SDK for the service, so adk-js takes the client as a constructor
argument and never reads the environment.

adk-python registers this metric in its evaluator registry. adk-js does not:
its registry builds an evaluator from an `EvalMetric` alone, and this one also
needs a client.

`evaluateInvocations` accepts a `conversationScenario` because the `Evaluator`
contract declares it. This metric derives what it needs from the turns
themselves, so the scenario does not reach the service.
