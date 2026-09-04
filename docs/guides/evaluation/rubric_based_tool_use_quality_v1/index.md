# Rubric based tool use quality v1

`RubricBasedToolUseV1Evaluator` asks a judge model whether an agent used its
tools the way a list of written rubrics says it should. Reach for it when the
answer alone does not tell you whether the agent worked correctly, for example
"a call is made to the geocoding tool" and "the forecast call reads the
geocoding output".

## Introduction

Grading tool use against a recorded golden trajectory pins the exact tool
names and arguments, which is too strict for an agent whose orchestration is
allowed to vary. This metric replaces the golden trajectory with rubrics. Each
rubric is one plain-English property of the tool usage, and the judge returns
one `yes` or `no` verdict for it.

A `yes` scores 1.0 and a `no` scores 0.0, so an invocation scores the mean of
the rubrics that were assessed, in `[0, 1]`. A rubric the judge did not score
stays unscored rather than counting as a failure. A judge is not a stable
oracle, so the metric samples it several times per invocation and settles each
rubric by majority vote; a tie counts as a `no`. The eval case scores the mean
over every rubric observation, and `overallEvalStatus` compares that mean
against the criterion's `threshold`.

The judge prompt carries the tool declarations the app offers, the user's
message, and every tool call paired with its response. It does not carry the
final answer, so this metric grades the work rather than the reply.

`RubricBasedEvaluator` is the base this metric stands on. It owns the rubric
bookkeeping, reads the verdicts back, and folds them into a score;
`LlmAsJudge` below it owns the sampling and the parallel-call limit.

The class is experimental, so its API may change.

## Get started

The criterion carries the threshold, the rubrics and the judge options. No
golden invocation is needed.

```ts
import {
  RubricBasedToolUseV1Evaluator,
  type EvalMetric,
  type Invocation,
} from '@google/adk';

const evalMetric: EvalMetric = {
  metricName: 'rubric_based_tool_use_quality_v1',
  criterion: {
    threshold: 0.8,
    rubrics: [
      {
        rubricId: '1',
        rubricContent: {textProperty: 'A call is made to the geocode tool.'},
      },
      {
        rubricId: '2',
        rubricContent: {
          textProperty: 'The get_weather call reads the geocode output.',
        },
      },
    ],
    judgeModelOptions: {judgeModel: 'gemini-2.5-flash', numSamples: 5},
  },
};

const evaluator = new RubricBasedToolUseV1Evaluator(evalMetric);

const actual: Invocation[] = [
  {
    userContent: {role: 'user', parts: [{text: 'Is it warm in Seattle?'}]},
    intermediateData: {
      toolUses: [
        {name: 'geocode', args: {place: 'Seattle'}, id: 'call1'},
        {name: 'get_weather', args: {lat: 47.6, lng: -122.3}, id: 'call2'},
      ],
      toolResponses: [
        {name: 'geocode', response: {lat: 47.6, lng: -122.3}, id: 'call1'},
        {name: 'get_weather', response: {celsius: 24}, id: 'call2'},
      ],
      intermediateResponses: [],
    },
  },
];

// `overallRubricScores` reports each rubric's mean across the invocations, and
// `overallScore` the mean over every rubric observation.
const result = await evaluator.evaluateInvocations(actual);
```

## Add rubrics per invocation

An `Invocation` carries its own `rubrics`, which the metric adds to the
criterion's. Only those whose `type` is `TOOL_USE_QUALITY` are used, so one
eval case can carry rubrics for several metrics.

```ts
const invocation: Invocation = {
  userContent: {role: 'user', parts: [{text: 'Is it warm in Seattle?'}]},
  rubrics: [
    {
      rubricId: '3',
      rubricContent: {textProperty: 'No tool is called twice.'},
      type: 'TOOL_USE_QUALITY',
    },
  ],
};
```

The criterion rubrics come first in the prompt, then the invocation rubrics.
Two rubrics may not share a `rubricId`, and at least one rubric must apply.
Either mistake throws `InputValidationError` when the prompt is formatted.

## What the judge sees

| Prompt section      | What it holds                                           |
| ------------------- | ------------------------------------------------------- |
| `<available_tools>` | The tools each agent declares, or `Agent has no tools.` |
| `<user_prompt>`     | The text of `userContent`.                              |
| `<response>`        | Each tool call with its response, or a no-steps note.   |
| `<properties>`      | One line per rubric, tagged with its id.                |

`<available_tools>` reads `appDetails`. Leave it out and the judge is told the
agent has no tools, which makes a rubric about tool choice unanswerable, so set
it when a rubric names a tool.

`<response>` reads `intermediateData`. A tool call that got no response is
reported with `"tool_response": "None"`.

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

## How a verdict reaches its rubric

The judge is asked to echo each rubric's id and its property text. The metric
resolves a verdict by id first, then by property text. The text comparison
ignores markdown and typographic decoration, so a judge that answers
`**Was the geocoder called?**` still resolves to the rubric that reads
`Was the geocoder called?`.

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
