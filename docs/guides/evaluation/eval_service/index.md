# BaseEvalService

`BaseEvalService` is the interface ADK uses to evaluate an agent. It splits an
eval into two calls: run the agent over an eval set, then score the results.
Reach for it when you build an eval runner, or when you consume one.

## Introduction

Evaluating an agent costs two very different things. Running the agent calls
the model once per invocation, takes minutes, and spends quota. Scoring the
output against a metric is usually cheap. `BaseEvalService` keeps the two
apart, so you pay for each only when you need it.

`performInference` runs the agent over the cases of an eval set and yields an
`InferenceResult` per case. `evaluate` takes those results and yields an
`EvalCaseResult` per case. An `InferenceResult` is a plain serializable record,
so you can save a run to disk and score it again later against a stricter
threshold, without running the agent a second time.

Both methods are async generators. An implementation yields each result as soon
as it has it, so a long eval set reports its first case in seconds. Results
arrive in completion order, not in the order of the cases in the request.

adk-js ships the contract and its data model. There is no built-in
implementation, so you write the class that runs your agent.

## Get started

This implements the service over a fixed set of cases, then consumes both
phases.

```ts
import {
  BaseEvalService,
  createEvaluateConfig,
  createInferenceConfig,
  EvalCaseResult,
  EvaluateRequest,
  EvalStatus,
  InferenceRequest,
  InferenceResult,
  InferenceStatus,
} from '@google/adk';

class EchoEvalService implements BaseEvalService {
  async *performInference(
    request: InferenceRequest,
  ): AsyncGenerator<InferenceResult, void, void> {
    for (const evalCaseId of request.evalCaseIds ?? ['case-1']) {
      yield {
        appName: request.appName,
        evalSetId: request.evalSetId,
        evalCaseId,
        sessionId: `session-${evalCaseId}`,
        status: InferenceStatus.SUCCESS,
        inferences: [
          {
            userContent: {role: 'user', parts: [{text: 'turn on the light'}]},
            finalResponse: {role: 'model', parts: [{text: 'done'}]},
          },
        ],
      };
    }
  }

  async *evaluate(
    request: EvaluateRequest,
  ): AsyncGenerator<EvalCaseResult, void, void> {
    for (const result of request.inferenceResults) {
      yield {
        evalSetId: result.evalSetId,
        evalId: result.evalCaseId,
        finalEvalStatus:
          result.status === InferenceStatus.SUCCESS
            ? EvalStatus.PASSED
            : EvalStatus.NOT_EVALUATED,
        overallEvalMetricResults: request.evaluateConfig.evalMetrics.map(
          (metric) => ({...metric, score: 1, evalStatus: EvalStatus.PASSED}),
        ),
        evalMetricResultPerInvocation: [],
        sessionId: result.sessionId ?? '',
      };
    }
  }
}

const service = new EchoEvalService();

const inferenceResults: InferenceResult[] = [];
for await (const result of service.performInference({
  appName: 'home_automation',
  evalSetId: 'smoke',
  inferenceConfig: createInferenceConfig(),
})) {
  inferenceResults.push(result);
}

let allPassed = true;
for await (const caseResult of service.evaluate({
  inferenceResults,
  evaluateConfig: createEvaluateConfig({
    evalMetrics: [
      {metricName: 'response_match_score', criterion: {threshold: 0.8}},
    ],
  }),
})) {
  allPassed &&= caseResult.finalEvalStatus === EvalStatus.PASSED;
}
```

## Configuration

`createInferenceConfig` and `createEvaluateConfig` fill in the defaults, so pass
only the fields you want to change.

`InferenceConfig`:

| Field                | Default | Meaning                                                    |
| -------------------- | ------- | ---------------------------------------------------------- |
| `parallelism`        | 4       | Inferences to run at the same time.                        |
| `useLive`            | `false` | Use bidirectional streaming. Live API models require it.   |
| `liveTimeoutSeconds` | 300     | Seconds to wait for a model turn in live mode.             |
| `labels`             | absent  | User-defined metadata that breaks down the billed charges. |

`EvaluateConfig`:

| Field         | Default  | Meaning                              |
| ------------- | -------- | ------------------------------------ |
| `evalMetrics` | required | The metrics to apply.                |
| `parallelism` | 4        | Evaluations to run at the same time. |

Raise `parallelism` against your model quota, not against your core count. A
model enforces a per-minute or per-second limit, and a large value spends that
limit quickly. Tools that the agent calls have their own limits too.

## Selecting cases

`InferenceRequest.evalCaseIds` filters the eval set. An implementation runs
every case in the set when the list is empty or absent. An id that matches no
case is skipped, not reported as an error.

## Failures are data, not exceptions

A failed inference is a result. The implementation sets `status` to
`InferenceStatus.FAILURE`, sets `errorMessage`, and continues with the next
case. The generator does not reject, so one broken case never ends the run.

Scoring works the same way. A metric that could not score a case reports
`EvalStatus.NOT_EVALUATED`, which is neither a pass nor a failure. Test for the
pass:

```ts
const passed = caseResult.finalEvalStatus === EvalStatus.PASSED;
```

Testing `!== EvalStatus.FAILED` counts an unscored case as a pass.

## Saving a run and scoring it later

`InferenceResult` holds no live handles, so `JSON.stringify` preserves it. Save
the results of an expensive run, and score them again whenever the metrics
change.

```ts
const saved = JSON.stringify(inferenceResults);
const restored: InferenceResult[] = JSON.parse(saved);

for await (const caseResult of service.evaluate({
  inferenceResults: restored,
  evaluateConfig: createEvaluateConfig({
    evalMetrics: [
      {metricName: 'response_match_score', criterion: {threshold: 0.95}},
    ],
  }),
})) {
  // Same inference, stricter threshold.
}
```

## Parity with adk-python

The field names are the camelCase aliases that adk-python puts on the wire, and
the enum numbers match. A JSON document that adk-python produces is assignable
to these types, and the reverse holds.
