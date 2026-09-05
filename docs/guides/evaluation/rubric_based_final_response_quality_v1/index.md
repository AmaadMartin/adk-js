# Rubric based final response quality v1

`RubricBasedFinalResponseQualityV1Evaluator` asks a judge model whether an
agent's final answer satisfies each of a list of written rubrics. Reach for it
when "correct" is a set of properties rather than one golden string, for
example "the answer is a numbered list" and "the answer states the average
salary for Marketing".

## Introduction

`FinalResponseMatchV2Evaluator` compares an answer against a golden answer, so
it needs one. Many agents have no single right answer: an open question, a
report, a summary. This metric replaces the golden answer with rubrics. Each
rubric is one plain-English property, and the judge returns one `yes` or `no`
verdict for it.

A `yes` scores 1.0 and a `no` scores 0.0, so an invocation scores the mean of
the rubrics that were assessed, in `[0, 1]`. A rubric the judge did not score
stays unscored rather than counting as a failure. A judge is not a stable
oracle, so the metric samples it several times per invocation and settles each
rubric by majority vote; a tie counts as a `no`. The eval case scores the mean
over every rubric observation, and `overallEvalStatus` compares that mean
against the criterion's `threshold`.

The judge reads more than the answer. The prompt carries the user's message,
the developer instructions of the agent that replied, the tool declarations the
app offers, the tool calls with their responses, and the grounding metadata the
model attached. That is what lets a rubric ask whether a claim is supported by
evidence rather than only whether it sounds right.

`RubricBasedEvaluator` is the base this metric stands on. It owns the rubric
bookkeeping, reads the verdicts back, and folds them into a score;
`LlmAsJudge` below it owns the sampling and the parallel-call limit.

## Get started

The criterion carries the threshold, the rubrics and the judge options. No
golden invocation is needed.

```ts
import {
  RubricBasedFinalResponseQualityV1Evaluator,
  type EvalMetric,
  type Invocation,
} from '@google/adk';

const evalMetric: EvalMetric = {
  metricName: 'rubric_based_final_response_quality_v1',
  criterion: {
    threshold: 0.8,
    rubrics: [
      {
        rubricId: '1',
        rubricContent: {textProperty: 'The response is direct.'},
      },
      {
        rubricId: '2',
        rubricContent: {
          textProperty: 'The response states the temperature in Celsius.',
        },
      },
    ],
    judgeModelOptions: {judgeModel: 'gemini-2.5-flash', numSamples: 5},
  },
};

const evaluator = new RubricBasedFinalResponseQualityV1Evaluator(evalMetric);

const actual: Invocation[] = [
  {
    userContent: {role: 'user', parts: [{text: 'Is it warm in Seattle?'}]},
    finalResponse: {role: 'model', parts: [{text: 'Yes, 24C and sunny.'}]},
  },
];

// `overallRubricScores` reports each rubric's mean across the invocations, and
// `overallScore` the mean over every rubric observation.
const result = await evaluator.evaluateInvocations(actual);
```

## Add rubrics per invocation

An `Invocation` carries its own `rubrics`, which the metric adds to the
criterion's. Only those whose `type` is `FINAL_RESPONSE_QUALITY` are used, so
one eval case can carry rubrics for several metrics.

```ts
const invocation: Invocation = {
  userContent: {role: 'user', parts: [{text: 'Is it warm in Seattle?'}]},
  finalResponse: {role: 'model', parts: [{text: 'Yes, 24C and sunny.'}]},
  rubrics: [
    {
      rubricId: '3',
      rubricContent: {textProperty: 'The response names the city.'},
      type: 'FINAL_RESPONSE_QUALITY',
    },
  ],
};
```

Two rubrics may not share a `rubricId`, and at least one rubric must apply.
Either mistake throws `InputValidationError` when the prompt is formatted.

## Configure the judge

`judgeModelOptions` holds the judge settings, and every field has a default.

| Field              | Default            | What it does                                   |
| ------------------ | ------------------ | ---------------------------------------------- |
| `judgeModel`       | `gemini-2.5-flash` | The model that grades the rubrics.             |
| `judgeModelConfig` | none               | The generation config each judge call carries. |
| `numSamples`       | `5`                | How many verdicts the judge gives per rubric.  |
| `parallelismLimit` | `1`                | How many judge calls run at once.              |

Raise `parallelismLimit` to finish a large eval case sooner, and keep it low
when the judge model has a small quota.

The criterion also carries `includeIntermediateResponsesInFinal`. It is false
by default, so the judge reads only the final response. Set it to true for an
agent that says something before it calls its tools: the text of the
intermediate events is then joined with the final response, in order.

## How a verdict reaches its rubric

The judge is asked to echo each rubric's id and its property text. The metric
resolves a verdict by id first, then by property text. The text comparison
ignores markdown and typographic decoration, so a judge that answers
`**Is the response direct?**` still resolves to the rubric that reads
`Is the response direct?`.

A verdict the metric cannot place is logged and dropped, so a judge that
invents a rubric cannot move the score.

## What a failure does

One failed judge call never fails the eval run. If any sample of an invocation
fails, that invocation is reported with no score and the status
`NOT_EVALUATED`, and the other invocations are graded as usual.

A judge that answers but writes something the metric cannot read produces the
same outcome for that sample: no rubric is scored, and the raw text is logged.
The metric also rejects a partial answer. If the judge writes a property with
no verdict, the whole sample scores nothing, because dropping the unanswered
rubric alone would raise the score of an agent the judge did not endorse.
