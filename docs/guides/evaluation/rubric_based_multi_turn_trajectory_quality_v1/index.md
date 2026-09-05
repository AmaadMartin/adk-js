# Rubric based multi-turn trajectory quality v1

`RubricBasedMultiTurnTrajectoryEvaluator` asks a judge model whether an agent's
whole conversation satisfies a list of written rubrics. Reach for it when the
property you care about spans turns, for example "the agent confirmed the
booking details with the user before it finalized the reservation".

## Introduction

The two per-invocation rubric metrics grade one turn at a time, so the judge
reads turn 3 without knowing what the user asked in turn 1. A property that
spans turns cannot be graded that way. This metric flattens the whole
conversation into one transcript and grades that transcript instead.

Each rubric is one plain-English property of the trajectory, and the judge
returns one `yes` or `no` verdict for it. A `yes` scores 1.0 and a `no` scores
0.0, so the conversation scores the mean of the rubrics that were assessed, in
`[0, 1]`. A rubric the judge did not score stays unscored rather than counting
as a failure.

The judge runs **once** per conversation, not once per turn. The metric
delegates the graded call to the last invocation, so `perInvocationResults`
holds one entry per invocation but only the last one carries a score. The first
N-1 entries carry `EvalStatus.NOT_EVALUATED`. This surprises a reader coming
from the per-invocation metrics, so check the last entry, or read
`overallScore`, rather than averaging the list yourself.

The prompt carries three things: the system instructions of every agent in the
conversation, the tool declarations those agents offer, and the flat dialogue.
The dialogue interleaves user turns, agent turns, tool calls and tool outputs,
each tagged with its turn number, so the judge can name the turn that broke a
property.

An invocation can carry its own rubrics alongside the criterion's. This metric
picks up the ones typed `TRAJECTORY_QUALITY` and ignores the rest, so one
recorded conversation can hold rubrics for several metrics at once. A rubric id
must be unique across both scopes; a collision is rejected.

`RubricBasedEvaluator` is the base this metric stands on. It owns the rubric
bookkeeping, reads the verdicts back and folds them into a score; `LlmAsJudge`
below it owns the sampling and the parallel-call limit.

The class is experimental, so its API may change.

## Get started

The criterion carries the threshold, the rubrics and the judge options. No
golden trajectory is needed.

```ts
import {
  RubricBasedMultiTurnTrajectoryEvaluator,
  type EvalMetric,
  type Invocation,
} from '@google/adk';

const evalMetric: EvalMetric = {
  metricName: 'rubric_based_multi_turn_trajectory_quality_v1',
  criterion: {
    threshold: 0.8,
    rubrics: [
      {
        rubricId: '1',
        rubricContent: {
          textProperty: 'The agent searched flights before it booked one.',
        },
      },
      {
        rubricId: '2',
        rubricContent: {
          textProperty: 'The agent confirmed the date before it booked.',
        },
      },
    ],
    judgeModelOptions: {judgeModel: 'gemini-2.5-flash', numSamples: 5},
  },
};

const conversation: Invocation[] = [
  {
    userContent: {parts: [{text: 'Find me a flight to Rome next Friday.'}]},
    finalResponse: {parts: [{text: 'I found three. Shall I book the 09:15?'}]},
    intermediateData: {
      invocationEvents: [
        {
          author: 'booking_agent',
          content: {
            parts: [
              {functionCall: {name: 'search_flights', args: {to: 'Rome'}}},
            ],
          },
        },
      ],
    },
  },
  {
    userContent: {parts: [{text: 'Yes, book it.'}]},
    finalResponse: {parts: [{text: 'Booked. Your reference is AB12CD.'}]},
  },
];

const result = await new RubricBasedMultiTurnTrajectoryEvaluator(
  evalMetric,
).evaluateInvocations(conversation);

console.log(result.overallScore, result.overallEvalStatus);
```

The evaluator resolves its judge from the `LLMRegistry` using
`judgeModelOptions.judgeModel`. Pass a `BaseLlm` as the second constructor
argument to grade with a model you built yourself.

## What the transcript looks like

The conversation above renders as the dialogue below. This is the text the
judge reads, so it is worth knowing when a rubric does not score the way you
expect.

```text
USER TURN 1: Find me a flight to Rome next Friday.
AGENT (booking_agent) TURN 1 (tool call): search_flights({"to":"Rome"})
AGENT (booking_agent) TURN 1: I found three. Shall I book the 09:15?
USER TURN 2: Yes, book it.
AGENT (agent) TURN 2: Booked. Your reference is AB12CD.
```

A turn with no recorded events is attributed to the literal name `agent`, as
turn 2 shows. An event whose author is `user` renders as a user turn rather
than an agent turn.

## Reading the result

`overallScore` and `overallEvalStatus` come from the single judge run. The
status compares the score against the criterion's `threshold`.

```ts
const last = result.perInvocationResults.at(-1);
for (const rubricScore of last?.rubricScores ?? []) {
  console.log(rubricScore.rubricId, rubricScore.score, rubricScore.rationale);
}
```

## Failure modes

- An empty conversation returns a `NOT_EVALUATED` result with no
  per-invocation entries. The judge is not called.
- A judge sample that fails is logged and dropped. When every sample of the
  last turn fails, that turn reports `NOT_EVALUATED` and the conversation
  scores nothing.
- Passing `expectedInvocations` of a different length than
  `actualInvocations` throws `InputValidationError`. The goldens are optional
  and this metric does not read them; they are paired onto the results so a
  caller can still see them.
- A conversation that resolves no rubric at all throws
  `InputValidationError`.
