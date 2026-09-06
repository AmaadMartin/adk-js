# Vertex AI eval facades

`SingleTurnVertexAiEvalFacade` and `MultiTurnVertexAiEvalFacade` score agent
behaviour with a metric of the Vertex AI Gen AI evaluation service. Reach for
them when a rule-based metric cannot express what you want to measure, and a
judge model can: coherence of one answer, or the quality of a whole
conversation.

## Introduction

Both facades implement `Evaluator`, so they plug in wherever a metric plugs in.
They differ in what one score covers.

`SingleTurnVertexAiEvalFacade` sends one request per invocation. Each
invocation gets its own score, and the overall score is the mean over the
invocations the service scored. Use it for a metric that judges one answer,
such as `COHERENCE`.

`MultiTurnVertexAiEvalFacade` sends one request for the whole conversation. The
service reads every turn but returns a single score, so only the last turn
carries it and the leading turns come back `NOT_EVALUATED`. Use it for a metric
that judges the conversation, such as `CONVERSATIONAL_COHERENCE` or
`MULTI_TURN_TASK_SUCCESS`.

The service has no JavaScript SDK. A facade therefore reaches it through a
`VertexAiEvalClient` that you supply, and you own authentication. That
interface has one method, so a test drives a facade with a fake client and no
network.

## Get started

Score a two-turn conversation:

```ts
import {
  EvalStatus,
  Invocation,
  MultiTurnVertexAiEvalFacade,
  VertexAiEvalClient,
  VertexAiEvalClientConfig,
  VertexAiEvalRequest,
  VertexEvaluationResult,
} from '@google/adk';

class MyEvalClient implements VertexAiEvalClient {
  constructor(private readonly config: VertexAiEvalClientConfig) {}

  async evaluate(
    request: VertexAiEvalRequest,
  ): Promise<VertexEvaluationResult> {
    // Send `request` to the service with `this.config`, and return the
    // summary metrics it answers with.
    return {summaryMetrics: [{meanScore: 0.9}]};
  }
}

const facade = new MultiTurnVertexAiEvalFacade({
  threshold: 0.8,
  metricName: 'CONVERSATIONAL_COHERENCE',
  client: new MyEvalClient({project: 'my-project', location: 'us-central1'}),
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

const result = await facade.evaluateInvocations(conversation);

result.overallScore; // 0.9
result.overallEvalStatus === EvalStatus.PASSED; // the score met the threshold
result.perInvocationResults[0].evalStatus === EvalStatus.NOT_EVALUATED;
result.perInvocationResults[1].evalStatus === EvalStatus.PASSED;
```

## Configure the client from the environment

`resolveVertexAiEvalClientConfig()` reads the configuration the service needs
from the environment, so a client can be built from it in one line:

```ts
import {resolveVertexAiEvalClientConfig} from '@google/adk';

const facade = new MultiTurnVertexAiEvalFacade({
  threshold: 0.8,
  metricName: 'MULTI_TURN_TASK_SUCCESS',
  client: new MyEvalClient(resolveVertexAiEvalClientConfig()),
});
```

`GOOGLE_API_KEY` wins when it is set. Otherwise the function reads
`GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`, and it needs both. An empty
value reads as an absent one. It throws an `InputValidationError` when the
environment names neither an API key nor both a project and a location.

Pass an environment of your own to read from something else:

```ts
const config = resolveVertexAiEvalClientConfig({
  GOOGLE_CLOUD_PROJECT: 'my-project',
  GOOGLE_CLOUD_LOCATION: 'us-central1',
});
```

## What the multi-turn request carries

The facade maps the conversation onto the agent-centric shape the service
scores. Each invocation becomes one turn, in conversation order, and the events
of a turn run `[user, ...intermediate, agent]`. A turn contributes intermediate
events only when its `intermediateData` holds invocation events; recorded tool
uses and tool responses contribute none.

The agents come from `invocation.appDetails.agentDetails`. An agent that
several turns declare is described by the first turn that declares it.

## Failure modes

- The two invocation lists must have the same length. A mismatch throws an
  `InputValidationError`, and it throws before the empty-list check.
- An empty conversation sends no request and returns an unevaluated result.
- When the service returns no usable score, the whole evaluation reports
  `NOT_EVALUATED` with no per-invocation results, matching `google/adk-python`.
- `evaluateInvocations` accepts a third `conversationScenario` argument because
  the `Evaluator` contract carries it. Both facades ignore it.
