# Final response match v2

`FinalResponseMatchV2Evaluator` asks a judge model whether an agent's final
response is valid against a golden response. Reach for it when a correct answer
has many wordings, so comparing the two texts directly reports a failure that a
human reader would call a pass.

## Introduction

A text-overlap metric scores the words two responses share. That punishes an
agent that answers correctly in its own words, reorders a list, or writes
`1,000,000` where the golden response writes `1000000`. This metric hands both
texts to a model instead, with the user's query, and asks it for one verdict:
valid or invalid.

A model is not a stable oracle, so the metric samples it several times per
invocation and takes the majority verdict. A tie counts as invalid. The overall
score is the fraction of invocations the judge called valid, in `[0, 1]`, and a
score closer to 1 is better. `overallEvalStatus` compares that fraction against
the criterion's `threshold`.

The judge is an ordinary ADK model. The criterion names it, and the registry
resolves the name the same way an agent's `model` string is resolved, so a
judge is any model ADK can reach. `LlmAsJudge` is the base this metric stands
on: it owns the sampling, the parallel-call limit and the failure handling, and
another judge metric extends it.

## Get started

The metric needs golden invocations, so pass both lists. The criterion carries
the threshold and the judge options.

```ts
import {
  FinalResponseMatchV2Evaluator,
  type Invocation,
  type LlmAsAJudgeMetric,
} from '@google/adk';

const evalMetric: LlmAsAJudgeMetric = {
  metricName: 'final_response_match_v2',
  criterion: {
    threshold: 0.8,
    judgeModelOptions: {judgeModel: 'gemini-2.5-flash', numSamples: 3},
  },
};

const evaluator = new FinalResponseMatchV2Evaluator(evalMetric);

const actual: Invocation[] = [
  {
    userContent: {role: 'user', parts: [{text: 'How tall is Mount Everest?'}]},
    finalResponse: {role: 'model', parts: [{text: 'About 8,849 metres.'}]},
  },
];
const expected: Invocation[] = [
  {
    userContent: {role: 'user', parts: [{text: 'How tall is Mount Everest?'}]},
    finalResponse: {role: 'model', parts: [{text: '8849 m'}]},
  },
];

// `overallScore` is the fraction of invocations the judge called valid, and
// `overallEvalStatus` compares it against the criterion's threshold.
const result = await evaluator.evaluateInvocations(actual, expected);
```

## Configure the judge

`judgeModelOptions` holds the judge settings, and every field has a default.

| Field              | Default            | What it does                                      |
| ------------------ | ------------------ | ------------------------------------------------- |
| `judgeModel`       | `gemini-2.5-flash` | The model that judges the responses.              |
| `judgeModelConfig` | none               | The generation config each judge call carries.    |
| `numSamples`       | `5`                | How many verdicts the judge gives per invocation. |
| `parallelismLimit` | `1`                | How many judge calls run at once.                 |

Raise `parallelismLimit` to finish a large eval case sooner, and keep it low
when the judge model has a small quota. A value below 1, or `numSamples` below
1, is rejected when the evaluator is constructed.

The criterion also carries `includeIntermediateResponsesInFinal`. It is false
by default, so the judge reads only the final response. Set it to true for an
agent that says something before it calls its tools: the text of the
intermediate events is then joined with the final response, in order, on both
the agent's side and the reference side.

## What a failure does

One failed judge call never fails the eval run. If any sample of an invocation
fails, that invocation is reported with no score and the status
`NOT_EVALUATED`, and the run continues. The overall score is the average over
the invocations that were evaluated, so an invocation the judge could not
answer is left out rather than counted as a zero.

A judge that answers, but writes a verdict the metric cannot read, produces the
same outcome for that sample: no score. The metric reads the
`is_the_agent_response_valid` field of the critique, and also accepts a judge
that names the field after the opposite verdict.
