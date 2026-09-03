# Running an eval locally

`LocalEvalService` runs an eval on the machine you start it on. It reads an
eval set, runs your agent over each case, then scores the invocations that come
back with the metrics you configure. Reach for it when you want to grade an
agent from your own process rather than from the `adk eval` command line.

## Introduction

The eval package splits one eval run into two halves that meet through
`InferenceResult`. Inference runs the agent and records what it did. Evaluation
scores that record against metrics. Keeping them apart means you can grade the
same run twice with different metrics, and you can grade a run somebody else
produced.

`LocalEvalService` implements both halves of `BaseEvalService`. It is the
piece that ties the eval substrate together: the eval set manager supplies the
cases, the `UserSimulatorProvider` supplies the user turns, the evaluation
generator drives the agent, the `MetricEvaluatorRegistry` resolves each metric
name to an evaluator, and the eval set results manager persists what came out.
Every one of those is an injectable, so a test can replace any of them.

Two properties matter when you run a whole eval set. The first is bounded
concurrency: both halves take a `parallelism` and never exceed it, so a large
eval set does not open a hundred model connections at once. The second is
failure isolation. One eval case whose run throws is reported as a `FAILURE`
result and the batch continues; one metric whose evaluator throws is reported
as `NOT_EVALUATED` and the other metrics still score. A single broken case
therefore costs you that case, not the run.

`MetricEvaluatorRegistry` maps a metric name to a factory that builds the
evaluator. Every instance is seeded with the metrics ADK ships, and each
instance owns its own map, so registering a custom metric on one registry does
not leak into another. `getEvaluator` builds a new evaluator on every call,
because an evaluator may keep state for the case it is scoring.

## Get started

Score an agent against a recorded eval set.

```typescript
import {
  EvalCaseResult,
  InferenceResult,
  InMemoryEvalSetsManager,
  LlmAgent,
  LocalEvalService,
  PrebuiltMetrics,
} from '@google/adk';

const evalSetsManager = new InMemoryEvalSetsManager();
await evalSetsManager.createEvalSet('home_automation', 'smoke');
await evalSetsManager.addEvalCase('home_automation', 'smoke', {
  evalId: 'two_turns',
  creationTimestamp: 0,
  sessionInput: {appName: 'home_automation', userId: 'home_user'},
  conversation: [
    {
      userContent: {role: 'user', parts: [{text: 'Turn the light on'}]},
      finalResponse: {role: 'model', parts: [{text: 'The light is on.'}]},
    },
  ],
});

const service = new LocalEvalService({
  rootAgent: new LlmAgent({name: 'home_agent', model: 'gemini-2.5-flash'}),
  evalSetsManager,
});

const inferenceResults: InferenceResult[] = [];
for await (const result of service.performInference({
  appName: 'home_automation',
  evalSetId: 'smoke',
  inferenceConfig: {useLive: false, parallelism: 4},
})) {
  inferenceResults.push(result);
}

const caseResults: EvalCaseResult[] = [];
for await (const caseResult of service.evaluate({
  inferenceResults,
  evaluateConfig: {
    evalMetrics: [
      {metricName: PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE, threshold: 1.0},
    ],
  },
})) {
  caseResults.push(caseResult);
}
```

Both methods are async generators that yield in completion order, not in input
order. Read `EvalCaseResult.finalEvalStatus` for the verdict on a case,
`overallEvalMetricResults` for each metric aggregated over the case, and
`evalMetricResultPerInvocation` for the score of each turn.

## Sessions

Each eval case runs in its own session. When the case pins
`sessionInput.sessionId`, that id is used verbatim, so artifacts pre-loaded
under it stay reachable and two runs of the same eval set do not collide.
Otherwise the service mints one through `sessionIdSupplier`, which prefixes a
random id so an eval session is recognizable in storage.

`EvalCaseResult.sessionDetails` carries the session as it stood after
inference. The service loads it under the eval case's `sessionInput.appName`
and `userId`, which is where the evaluation generator created it. A case with
no `sessionInput` therefore leaves `sessionDetails` absent, because the
generator created the session under its own default app name.

## Registering a metric

Pass your own registry to add a metric, or to supply a dependency an evaluator
needs.

```typescript
import {
  LocalEvalService,
  MetricEvaluatorRegistry,
  ResponseEvaluator,
} from '@google/adk';

const metricEvaluatorRegistry = new MetricEvaluatorRegistry();
metricEvaluatorRegistry.registerEvaluator(
  'response_evaluation_score',
  (evalMetric) => new ResponseEvaluator({evalMetric, evalClient}),
);

const service = new LocalEvalService({
  rootAgent,
  evalSetsManager,
  metricEvaluatorRegistry,
});
```

`response_evaluation_score` is scored by the Vertex AI Gen AI evaluation
service, which has no JavaScript SDK, so its client is injected. The seeded
factory builds a `ResponseEvaluator` without one, which rejects the call and
names the missing client.

An unregistered metric name throws `NotFoundError` from `getEvaluator`. That
error is caught like any other metric failure, so the case still produces a
result with that metric marked `NOT_EVALUATED`.

## Rubrics

An `EvalCase` and an `Invocation` can each carry `rubrics`: testable criteria a
rubric-based evaluator judges a response against. Before the metrics run, the
service copies the case's rubrics onto every actual invocation, then each
expected invocation's rubrics onto the actual invocation at the same index. A
rubric id used at both levels collides, and the service reports it as an
`InputValidationError` rather than silently keeping one of the two.

## Persisting results

Supply `evalSetResultsManager` to save what a run produced. The service groups
the results by eval set and saves each group once, after the `evaluate` stream
drains. A consumer that abandons the generator part-way saves nothing.

```typescript
import {LocalEvalSetResultsManager} from '@google/adk';

const service = new LocalEvalService({
  rootAgent,
  evalSetsManager,
  evalSetResultsManager: new LocalEvalSetResultsManager(agentsDir),
});
```

## Failures you can expect

| Condition                                                | Result                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| The app has no eval set with that id                     | `performInference` throws `NotFoundError`                        |
| An eval case's run throws                                | That case yields `InferenceStatus.FAILURE` with `errorMessage`   |
| An eval case carries no `conversation`                   | The run fails, because the user simulator has no turns to replay |
| An inference result names an unknown eval case           | `evaluate` throws `NotFoundError`                                |
| The inference count differs from the conversation length | `evaluate` throws `InputValidationError`                         |
| An evaluator throws                                      | That metric scores `NOT_EVALUATED`; the others still score       |
| An inference produced nothing                            | The case result is `FAILED` with no metric results               |

Every LLM call the service makes runs under the `EVAL_CLIENT_LABEL` client
label, so the model charges an eval incurs can be told apart from the charges
of serving traffic.
