# MultiTurnToolUseQualityV1Evaluator

`MultiTurnToolUseQualityV1Evaluator` grades the tool calls an agent made over a
whole conversation. It sends every turn to the `MULTI_TURN_TOOL_USE_QUALITY`
rubric metric of the Vertex AI Gen AI evaluation service and reports one score
for the conversation. Reach for it when the question is "did the agent call the
right tools, with the right arguments, at the right time", rather than "was the
final answer correct".

## Introduction

Most evaluators in ADK score one turn at a time. That works for a final
response, but it cannot see a tool call that only looks wrong in context: a
lookup the agent repeated three turns later, or a booking it made before it had
the date. This metric reads the conversation as a unit, so the score reflects
the whole trajectory.

The metric is reference free. You do not need golden invocations, because the
service judges the tool calls against a rubric instead of against a recorded
answer. You may still pass expected invocations; they are paired with the actual
ones in `perInvocationResults` and are reported back untouched.

Two neighbouring pieces are worth knowing:

- `MultiTurnVertexAiEvalFacade` is the general facade over a multi-turn metric
  of the service. This class is the preconfigured form of it: it pins the metric
  name and resolves the threshold. Use the facade directly for a metric that
  has no evaluator of its own.
- `SafetyEvaluatorV1` has the same shape but wraps a single-turn metric, so it
  sends one request per turn and averages the scores. This one sends a single
  request for the conversation.

The service has no JavaScript SDK. You write the transport yourself as a
`VertexAiEvalClient`, and you own authentication; the evaluator never reads the
environment. `resolveVertexAiEvalClientConfig()` reads `GOOGLE_API_KEY`, or
`GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`, in the order adk-python
uses. It returns that configuration only; building a client from it is your
job.

## Get started

```ts
import {
  EvalStatus,
  Invocation,
  MultiTurnToolUseQualityV1Evaluator,
  PrebuiltMetrics,
  VertexAiEvalClient,
} from '@google/adk';

// Your transport to the evaluation service.
declare const evalClient: VertexAiEvalClient;

const evaluator = new MultiTurnToolUseQualityV1Evaluator({
  evalMetric: {
    metricName: PrebuiltMetrics.MULTI_TURN_TOOL_USE_QUALITY_V1,
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

- `overallScore` is the score the service returned for the conversation, or
  `undefined` when it returned none.
- `overallEvalStatus` is `PASSED` when the score reaches the threshold, `FAILED`
  when it does not, and `NOT_EVALUATED` when there is no score.
- `perInvocationResults` carries one entry per turn, in order. The service
  scores the conversation as a whole, so only the last turn carries the score
  and every earlier turn is `NOT_EVALUATED`.

An empty conversation sends no request and comes back `NOT_EVALUATED` with an
empty `perInvocationResults`.

## Failure modes

- Actual and expected invocation lists of different lengths are rejected with
  `InputValidationError`, before any request reaches the service.
- A rejection from your client propagates unchanged. The evaluator does not
  retry it, wrap it, or swallow it.

## Divergence from adk-python

adk-python pins the metric version, requesting
`RubricMetric.MULTI_TURN_TOOL_USE_QUALITY` at `version="v1"`. The request type
in adk-js names a metric but carries no version field, so the request omits it.
`SafetyEvaluatorV1` has the same limitation.

`evaluateInvocations` accepts a `conversationScenario` because the `Evaluator`
contract declares it. This metric derives what it needs from the turns
themselves, so the scenario does not reach the service.
