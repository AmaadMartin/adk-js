# LlmAsJudge

`LlmAsJudge` is the base class for an evaluation metric that a model grades.
Extend it when the quality you want to measure is a judgement — is the answer
grounded, is it helpful, does it follow the instruction — rather than something
a string comparison or a tool trajectory can decide.

## Introduction

Most built-in metrics compare an agent's run against a recording. That works
when the expected output is exact. It does not work for a question such as "is
this answer helpful", because two helpful answers share almost no text.

An auto-rater answers that kind of question. You send the invocation to a model
with a grading prompt, and you read a score out of the reply. `LlmAsJudge` is
an `Evaluator`, so a metric built on it returns the same `EvaluationResult` as
every other metric and slots into the same eval run.

A judge model is not deterministic. The same prompt can score 0.6 once and 0.8
the next time. `LlmAsJudge` handles that by asking the same question several
times and folding the answers together, which is why grading is split into two
aggregation steps:

- `aggregatePerInvocationSamples` folds the repeated samples of one invocation
  into one result. This is where you decide between a mean, a median or a
  majority vote.
- `aggregateInvocationResults` folds the per-invocation results into the
  overall result for the eval case.

The base class owns everything between those two: it validates the criterion,
resolves the judge model and the threshold, builds one prompt per invocation,
runs the samples under one parallelism budget, and isolates a sample that
fails.

## Get started

A metric supplies four behaviours. The prompt, the reply parser, and the two
aggregation steps:

```ts
import {
  AutoRaterScore,
  EvalStatus,
  EvaluationResult,
  Invocation,
  LlmAsAJudgeCriterion,
  LlmAsJudge,
  LlmResponse,
  PerInvocationResult,
  getEvalStatus,
  getTextFromContent,
  parseLlmAsAJudgeCriterion,
} from '@google/adk';

/** Scores how well the agent's answer matches the golden one. */
class ResponseQualityJudge extends LlmAsJudge<LlmAsAJudgeCriterion> {
  formatAutoRaterPrompt(actual: Invocation, expected?: Invocation): string {
    return [
      'Rate the answer between 0 and 1. Reply with the number only.',
      `Question: ${getTextFromContent(actual.userContent)}`,
      `Answer: ${getTextFromContent(actual.finalResponse)}`,
      `Reference: ${getTextFromContent(expected?.finalResponse)}`,
    ].join('\n');
  }

  convertAutoRaterResponseToScore(response: LlmResponse): AutoRaterScore {
    const score = Number.parseFloat(getTextFromContent(response.content));
    return {score: Number.isNaN(score) ? undefined : score};
  }

  aggregatePerInvocationSamples(
    samples: PerInvocationResult[],
  ): PerInvocationResult {
    const scores = samples.flatMap((sample) =>
      sample.score === undefined ? [] : [sample.score],
    );
    const score =
      scores.length === 0
        ? undefined
        : scores.reduce((total, value) => total + value, 0) / scores.length;
    return {
      ...samples[0],
      score,
      evalStatus: getEvalStatus(score, this.threshold),
    };
  }

  aggregateInvocationResults(results: PerInvocationResult[]): EvaluationResult {
    const passed = results.filter(
      (result) => result.evalStatus === EvalStatus.PASSED,
    ).length;
    const overallScore = passed / results.length;
    return {
      overallScore,
      overallEvalStatus: getEvalStatus(overallScore, this.threshold),
      perInvocationResults: results,
    };
  }
}
```

Construct it with the metric it grades, and the parser that validates that
metric's criterion:

```ts
const judge = new ResponseQualityJudge({
  evalMetric: {
    metricName: 'response_quality_v1',
    criterion: {
      threshold: 0.6,
      judgeModelOptions: {
        judgeModel: 'gemini-2.5-flash',
        numSamples: 3,
        parallelismLimit: 2,
      },
    },
  },
  parseCriterion: parseLlmAsAJudgeCriterion,
});

const result = await judge.evaluateInvocations(
  actualInvocations,
  expectedInvocations,
);
```

`evaluateInvocations` returns whatever `aggregateInvocationResults` returned.
When nothing was graded it returns an empty result instead, and does not call
your aggregation at all.

The constructor resolves and builds the judge model, so the model's
credentials must already be available when you construct the metric.

## Configuring the judge model

The criterion carries a `judgeModelOptions` object. Use
`parseLlmAsAJudgeCriterion` to validate one that came from a config file: it
applies the defaults below and rejects a value that cannot work.

| Option             | Default            | What it does                                                                                        |
| ------------------ | ------------------ | --------------------------------------------------------------------------------------------------- |
| `judgeModel`       | `gemini-2.5-flash` | The model name. `LLMRegistry` resolves it, and construction fails when no registered class matches. |
| `judgeModelConfig` | none               | The `GenerateContentConfig` for the judge call.                                                     |
| `numSamples`       | `5`                | How many times each invocation is graded.                                                           |
| `parallelismLimit` | `1`                | The maximum number of judge calls in flight. Must be at least 1.                                    |

The parallelism budget covers the whole `evaluateInvocations` call, not one
invocation. Two invocations at three samples each with a limit of 2 make six
calls, never more than two at a time.

To grade against a model the registry does not own, pass it directly:

```ts
const judge = new ResponseQualityJudge({
  evalMetric,
  parseCriterion: parseLlmAsAJudgeCriterion,
  judgeModel: myOwnBaseLlmInstance,
});
```

For a metric that grades against rubrics, use `parseRubricsBasedCriterion`
instead. It adds a validated `rubrics` list to the same options, and the score
your parser returns can carry a `rubricScores` entry per rubric.

## Failure modes

The constructor throws an `InputValidationError` when the metric carries no
criterion, when the parser rejects the criterion, or when neither the criterion
nor the metric declares a threshold. An unknown judge model name throws from
`LLMRegistry`.

`evaluateInvocations` throws an `InputValidationError` when the two invocation
lists have different lengths, and when the metric was built with
`expectedInvocationsRequired: true` but the caller supplied none.

A judge call that fails does not fail the run. The evaluator logs a warning and
marks that one invocation `NOT_EVALUATED` with no score; the other invocations
are graded as usual. `aggregatePerInvocationSamples` is not called for an
invocation whose samples did not all come back. A judge that returns no
response at all counts as a failed call.
