# Running an eval locally

`LocalEvalService` runs an eval in your own process. It drives the agent over
the cases of an eval set, then scores what the agent produced against the
metrics you configured. Reach for it when you want a pass or fail verdict for
an agent, rather than the raw record of what it did.

## Introduction

An eval has two phases, and this service keeps them apart.

The first phase is inference. `performInference` reads an eval set through an
`EvalSetsManager`, runs the agent once per selected case, and yields an
`InferenceResult` for each. The result carries the invocations the agent
produced: the user turn, the final answer, and the tool calls in between. This
phase costs model calls.

The second phase is evaluation. `evaluate` takes those inference results and
scores each one against the configured metrics. It yields an `EvalCaseResult`
per inference result and, when you gave it an `EvalSetResultsManager`, saves
the run once the stream is drained. This phase is cheap for a deterministic
metric and costs model calls for an autorater one.

Splitting the phases means you can score the same run twice, with different
metrics, without running the agent again. It is also why `evaluate` takes
inference results rather than an eval set id.

Both phases stream. A result is yielded as soon as its case finishes, so a long
eval reports progress instead of going quiet. Both phases also bound how many
cases run at a time, through `parallelism`, which defaults to
`DEFAULT_EVAL_PARALLELISM`. Results therefore arrive in completion order, not
in eval set order.

The two phases differ in how they treat a failure, and the difference is
deliberate. An agent that throws during inference is a result, not an error:
the case is yielded with `InferenceStatus.FAILURE` and its message, and the
other cases keep running. A metric that throws is also a result: that metric
scores `NOT_EVALUATED` and the other metrics of the same case still score. A
missing eval set or a missing eval case, on the other hand, throws — nothing
useful can be reported for a case that does not exist.

## Get started

The service needs an agent and an `EvalSetsManager`. Everything else has a
default: an in-memory session service, an in-memory artifact service, and the
registry of the metrics ADK ships.

```typescript
import {
  EvalStatus,
  EvalSetsManager,
  InferenceResult,
  LlmAgent,
  LocalEvalService,
} from '@google/adk';

/** Returns the id of every case that failed. */
async function runEval(evalSetsManager: EvalSetsManager): Promise<string[]> {
  const service = new LocalEvalService({
    rootAgent: new LlmAgent({
      name: 'weather_agent',
      model: 'gemini-flash-latest',
      instruction: 'answer weather questions',
    }),
    evalSetsManager,
  });

  const inferenceResults: InferenceResult[] = [];
  for await (const inferenceResult of service.performInference({
    appName: 'weather_app',
    evalSetId: 'smoke',
    inferenceConfig: {useLive: false, parallelism: 4},
  })) {
    inferenceResults.push(inferenceResult);
  }

  const failed: string[] = [];
  for await (const evalCaseResult of service.evaluate({
    inferenceResults,
    evaluateConfig: {
      evalMetrics: [{metricName: 'tool_trajectory_avg_score', threshold: 1.0}],
    },
  })) {
    if (evalCaseResult.finalEvalStatus !== EvalStatus.PASSED) {
      failed.push(evalCaseResult.evalId);
    }
  }
  return failed;
}
```

## Selecting cases

`performInference` runs every case of the eval set unless `evalCaseIds` names
some. An empty array counts as naming none, so it runs the whole set:

```typescript
// Runs case1 and case3, in eval set order.
const results = service.performInference({
  appName: 'weather_app',
  evalSetId: 'smoke',
  evalCaseIds: ['case1', 'case3'],
  inferenceConfig: {useLive: false},
});
```

## Sessions

Each case runs in its own session. By default the service creates one under a
generated id that starts with `EVAL_SESSION_ID_PREFIX`, which marks it as a
session an eval run owns rather than a user's own.

A case that sets `sessionInput.sessionId` pins the id instead. Pinning matters
when the case needs artifacts: an artifact is keyed by app name, user id and
session id, so a case can only reach a pre-loaded artifact under the id it was
saved with. A pinned id is reused on every run of the case.

The user id comes from `sessionInput.userId`, and falls back to `test_user_id`
when the case names none.

## Metrics

A metric is resolved by name through a `MetricEvaluatorRegistry`. The service
builds the default registry when you give it none. Register your own evaluator
to score a metric ADK does not ship:

```typescript
import {
  EvalStatus,
  EvaluationResult,
  Evaluator,
  Invocation,
  MetricEvaluatorRegistry,
} from '@google/adk';

/** Passes an invocation whose answer is short enough. */
class BrevityEvaluator implements Evaluator {
  constructor(private readonly maxWords: number) {}

  evaluateInvocations(actualInvocations: Invocation[]): EvaluationResult {
    const perInvocationResults = actualInvocations.map((actualInvocation) => {
      const words = (actualInvocation.finalResponse?.parts ?? []).flatMap(
        (part) => (part.text ?? '').split(/\s+/).filter(Boolean),
      );
      const score = words.length <= this.maxWords ? 1 : 0;
      return {
        actualInvocation,
        score,
        evalStatus: score === 1 ? EvalStatus.PASSED : EvalStatus.FAILED,
      };
    });
    const failed = perInvocationResults.some((result) => result.score === 0);
    return {
      overallScore: failed ? 0 : 1,
      overallEvalStatus: failed ? EvalStatus.FAILED : EvalStatus.PASSED,
      perInvocationResults,
    };
  }
}

const registry = new MetricEvaluatorRegistry();
registry.registerEvaluator('brevity', () => new BrevityEvaluator(20));
```

Give that registry to the service as `metricEvaluatorRegistry`, then name
`brevity` in `evaluateConfig.evalMetrics`.

Each registry owns its registrations, so a metric registered for one app is not
resolvable through another app's registry.

## Verdicts

`generateFinalEvalStatus` folds the per-metric verdicts into the verdict for
the whole case. One failing metric fails the case. A metric that was not
evaluated is skipped. A case whose metrics were all skipped is itself
`NOT_EVALUATED`, which is not the same as passing.

## Saving results

Pass an `EvalSetResultsManager` to persist a run. The service calls
`saveEvalSetResult` once per distinct eval set, after `evaluate`'s stream is
drained. A consumer that stops reading early saves nothing, so a partial run
never overwrites a complete one.
