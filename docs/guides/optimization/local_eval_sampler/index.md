# LocalEvalSampler

`LocalEvalSampler` is the `Sampler` an optimizer uses when your examples are
already ADK eval sets. It runs a candidate agent through `LocalEvalService` and
turns each eval case's verdict into a score, so you do not write the eval loop
or the score derivation yourself.

## Introduction

An optimizer proposes candidate agents and keeps the ones that score better. It
cannot judge a candidate on its own, so it calls a `Sampler`. Writing that
sampler means driving an evaluation service, collecting the results, and
reducing each result to a number. `LocalEvalSampler` is that work, already
done, for the common case where the examples live in an `EvalSetsManager` and
the metrics live in an `EvalConfig`.

The score is deliberately blunt. A case whose final status is `PASSED` scores
`1.0`. Every other status, including `NOT_EVALUATED`, scores `0.0`. The
threshold that decides pass from fail is the one in your eval config, so you
tune the difficulty there rather than in the sampler.

The sampler holds two example sets. `trainEvalSet` is what an optimizer
searches against. `validationEvalSet` is the held-out set it confirms the
winner on. Configure only `trainEvalSet` and both sets are the same set. The
resolution has one subtlety worth knowing: with no `validationEvalSet`
configured, the validation eval case ids are the _train_ ids, so a configured
subset of train cases carries over to validation instead of widening to the
whole set.

Build a sampler with `LocalEvalSampler.create()`, not with `new`. Resolving the
eval case ids reads the `EvalSetsManager`, whose methods are asynchronous in
adk-js, and a constructor cannot await.

## Get started

Scoring one candidate over an eval set of two cases.

```ts
import {
  InMemoryEvalSetsManager,
  LlmAgent,
  LocalEvalSampler,
  Sampler,
} from '@google/adk';

const evalSetsManager = new InMemoryEvalSetsManager();
await evalSetsManager.createEvalSet('geography_app', 'capitals');
await evalSetsManager.addEvalCase('geography_app', 'capitals', {
  evalId: 'capital_of_france',
  conversation: [
    {
      userContent: {
        role: 'user',
        parts: [{text: 'What is the capital of France?'}],
      },
      finalResponse: {
        role: 'model',
        parts: [{text: 'The capital of France is Paris.'}],
      },
    },
  ],
});

const sampler = await LocalEvalSampler.create({
  config: {
    evalConfig: {criteria: {response_match_score: 0.8}},
    appName: 'geography_app',
    trainEvalSet: 'capitals',
  },
  evalSetsManager,
});

const candidate = new LlmAgent({
  name: 'geography_agent',
  model: 'gemini-2.5-flash',
  instruction: 'Answer the question in one sentence.',
});

const {scores} = await sampler.sampleAndScore({
  candidate,
  exampleSet: Sampler.TRAIN_SET,
});
// scores: {capital_of_france: 1}
```

`samples/optimization/local_eval_sampler/agent.ts` is the same flow with a
local model in place of Gemini, so it runs with no credentials and no network.

## Choosing what to score

`sampleAndScore()` takes the candidate plus three optional settings.

- `exampleSet` selects `Sampler.TRAIN_SET` or `Sampler.VALIDATION_SET`. It
  defaults to the validation set.
- `batch` names the eval case ids to run, in place of the whole set. An
  optimizer uses it to score a random subset per round.
- `captureFullEvalData` asks for the evaluation data alongside the scores.

`getTrainExampleIds()` and `getValidationExampleIds()` return the ids resolved
at `create()` time. They never query the manager again.

## Reading back what happened

With `captureFullEvalData: true`, the result carries a `data` map keyed by eval
case id. Each entry holds the eval case's `conversationScenario`, when it has
one, and one record per invocation: the user prompt, the agent's response, the
tool calls with their responses, and each metric's rounded score and status
name.

```ts
const {scores, data} = await sampler.sampleAndScore({
  candidate,
  captureFullEvalData: true,
});

const failures = Object.entries(scores)
  .filter(([, score]) => score === 0)
  .map(([evalId]) => data?.[evalId]);
```

Parts the model marked as thoughts are left out of both texts, so an optimizer
reads what the user and the agent actually said. Scores are rounded to two
decimals; a metric that was not scored keeps an undefined score rather than a
zero. The status is the `EvalStatus` name, such as `'PASSED'`, which is what
adk-python writes too.

Without `captureFullEvalData`, the result has no `data` key at all.

## Failure modes

- `create()` throws `NotFoundError` when a configured eval set does not exist
  for the app and the config does not list that set's eval case ids.
- A metric name with no registered evaluator throws `NotFoundError` from
  `MetricEvaluatorRegistry` when the eval runs.
- A case whose inference fails is reported by `LocalEvalService` as a `FAILED`
  case with no per-invocation results, and therefore scores `0.0`.
- `sampleAndScore()` returns one score per result the eval service yielded, not
  one per requested id. A case the service drops is absent from `scores`.

## Custom metrics

The sampler resolves metric names against a `MetricEvaluatorRegistry`. It
builds a fresh one per sampler, so a metric registered for one app cannot leak
into another app's evaluations. To score a metric ADK does not ship, register
an evaluator for it and pass the registry in.

```ts
import type {EvaluationResult, Evaluator, Invocation} from '@google/adk';
import {EvalStatus, MetricEvaluatorRegistry} from '@google/adk';

/** Passes an invocation whose answer stays under `threshold` characters. */
class AnswerLengthEvaluator implements Evaluator {
  constructor(private readonly threshold: number) {}

  evaluateInvocations(actualInvocations: Invocation[]): EvaluationResult {
    const perInvocationResults = actualInvocations.map((actualInvocation) => {
      const length = (actualInvocation.finalResponse?.parts ?? [])
        .map((part) => part.text ?? '')
        .join('').length;
      return {
        actualInvocation,
        score: length,
        evalStatus:
          length <= this.threshold ? EvalStatus.PASSED : EvalStatus.FAILED,
      };
    });
    return {
      overallEvalStatus: perInvocationResults.every(
        (result) => result.evalStatus === EvalStatus.PASSED,
      )
        ? EvalStatus.PASSED
        : EvalStatus.FAILED,
      perInvocationResults,
    };
  }
}

const metricEvaluatorRegistry = new MetricEvaluatorRegistry();
metricEvaluatorRegistry.registerEvaluator(
  'answer_length',
  (evalMetric) => new AnswerLengthEvaluator(evalMetric.threshold ?? 120),
);

const sampler = await LocalEvalSampler.create({
  config: {
    evalConfig: {criteria: {answer_length: 120}},
    appName: 'geography_app',
    trainEvalSet: 'capitals',
  },
  evalSetsManager,
  metricEvaluatorRegistry,
});
```
