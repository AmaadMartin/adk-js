# LocalEvalSampler

`LocalEvalSampler` is the `Sampler` that scores a candidate agent with ADK's own
`LocalEvalService`. Reach for it when you already have eval sets and want an
optimizer to score candidates against them, with the same metrics `adk eval`
uses.

## Introduction

An optimizer proposes candidate agents and keeps the ones that score better. It
cannot score a candidate itself: scoring needs your examples, your metrics and
an evaluation service. `Sampler` is that seam, and `LocalEvalSampler` is the
implementation that bridges it to `LocalEvalService`.

One call to `sampleAndScore()` does three things. It runs inference for the
candidate over the eval cases you selected, it scores the inferences against the
metrics in your `EvalConfig`, and it maps each case's `finalEvalStatus` to a
number: 1.0 for `PASSED`, 0.0 for everything else. A case that failed and a case
that was never evaluated both score 0.0, so a metric your registry cannot
resolve costs the candidate that case.

The sampler holds two example sets. The train set is what an optimizer searches
against; the validation set is the held-out data it scores the winner on. You
name the train set, and optionally a separate validation set. Either set can be
narrowed to specific eval case ids. A config that names no validation set
validates on the train cases.

Build it with `LocalEvalSampler.create()`, not `new`. adk-js's `EvalSetsManager`
is asynchronous, and the factory has to await it to turn an eval set id into the
eval case ids `getTrainExampleIds()` returns.

## Get started

A candidate scored against two eval cases. It runs offline: the model replays a
fixed reply, and the metric is registered in the snippet.

```ts
import {
  EvaluationResult,
  Evaluator,
  EvalStatus,
  InMemoryEvalSetsManager,
  Invocation,
  LlmAgent,
  LocalEvalSampler,
  MetricEvaluatorRegistry,
  Sampler,
} from '@google/adk';

const APP_NAME = 'support_app';
const EVAL_SET_ID = 'greetings';
const METRIC_NAME = 'reply_is_polite';

/** Passes an invocation whose reply thanks the user. */
class PolitenessEvaluator implements Evaluator {
  evaluateInvocations(actualInvocations: Invocation[]): EvaluationResult {
    const perInvocationResults = actualInvocations.map((actualInvocation) => {
      const reply = (actualInvocation.finalResponse?.parts ?? [])
        .map((part) => part.text ?? '')
        .join('')
        .toLowerCase();
      const polite = reply.includes('happy to help');
      return {
        actualInvocation,
        score: polite ? 1 : 0,
        evalStatus: polite ? EvalStatus.PASSED : EvalStatus.FAILED,
      };
    });
    const passed = perInvocationResults.every(
      (result) => result.evalStatus === EvalStatus.PASSED,
    );
    return {
      overallScore: passed ? 1 : 0,
      overallEvalStatus: passed ? EvalStatus.PASSED : EvalStatus.FAILED,
      perInvocationResults,
    };
  }
}

const evalSetsManager = new InMemoryEvalSetsManager();
await evalSetsManager.createEvalSet(APP_NAME, EVAL_SET_ID);
await evalSetsManager.addEvalCase(APP_NAME, EVAL_SET_ID, {
  evalId: 'greeting',
  conversation: [
    {
      userContent: {role: 'user', parts: [{text: 'say greeting'}]},
      finalResponse: {role: 'model', parts: [{text: 'anything'}]},
    },
  ],
});

const metricEvaluatorRegistry = new MetricEvaluatorRegistry();
metricEvaluatorRegistry.registerEvaluator(
  METRIC_NAME,
  () => new PolitenessEvaluator(),
);

const sampler = await LocalEvalSampler.create({
  config: {
    evalConfig: {criteria: {[METRIC_NAME]: 0.5}},
    appName: APP_NAME,
    trainEvalSet: EVAL_SET_ID,
  },
  evalSetsManager,
  metricEvaluatorRegistry,
});

const result = await sampler.sampleAndScore({
  candidate: new LlmAgent({name: 'polite', model: myModel}),
  exampleSet: Sampler.TRAIN_SET,
});
// result.scores -> {greeting: 1}
```

`samples/optimization/local_eval_sampler/agent.ts` is this snippet as a runnable
sample, with a scripted model in place of `myModel`.

## Selecting the eval cases

Four config fields decide what a call evaluates.

| Field                   | Meaning when omitted                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `trainEvalSet`          | Required.                                                                               |
| `trainEvalCaseIds`      | Every eval case in the train set.                                                       |
| `validationEvalSet`     | The train set is used for validation too.                                               |
| `validationEvalCaseIds` | Every eval case in the validation set. With no `validationEvalSet`, the train case ids. |

`create()` resolves those ids once, by reading each eval set. It throws
`NotFoundError` when a set the config names does not exist, so a typo fails at
construction rather than at the first score.

A `sampleAndScore()` call can narrow further. `exampleSet` picks the set and
defaults to `Sampler.VALIDATION_SET`. `batch` overrides the resolved ids for
that one call, which is how an optimizer scores a mini-batch.

## Capturing the data an optimizer improves against

`captureFullEvalData` defaults to false, and then the result carries only
`scores`. Set it to true and `result.data` holds one entry per eval case:

- `conversationScenario`, when the eval case has one.
- `invocations`, one entry per scored invocation. Each carries
  `actualInvocation`, `expectedInvocation` when the eval case recorded a
  reference, and `evalMetricResults`.

An invocation entry reports the user prompt, the agent response, and the tool
calls with their responses. Text parts marked as thoughts are left out of both
strings. A metric score is rounded to two decimals, and is `undefined` when the
metric produced none. `evalStatus` is the enum name, `'PASSED'` or
`'NOT_EVALUATED'`, so the captured data reads the same as adk-python's.

## Metrics

The sampler passes `metricEvaluatorRegistry` straight to `LocalEvalService`, and
defaults to `defaultMetricEvaluatorRegistry()` when you give none. That default
knows the metrics ADK ships with.

adk-js cannot resolve a scoring function named by module path, so
`customMetrics` in an `EvalConfig` is not turned into an evaluator. Register the
metric on a `MetricEvaluatorRegistry` and pass it in, as the example above does.
A metric nothing resolves is reported as unmet, and the case scores 0.0.

## Logging

Each `sampleAndScore()` call logs one line at debug level:
`Evaluation summary: 3 PASSED, 2 FAILED`. The `OTHER` count is appended only
when a case landed on neither status.
