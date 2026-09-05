# Rubric based multi-turn trajectory evaluator

`RubricBasedMultiTurnTrajectoryEvaluator` asks a judge model whether an agent
handled a whole conversation the way a list of written rubrics says it should.
Reach for it when no single turn holds the answer, for example "the agent
confirmed the price before it booked" or "the final reply carried a
confirmation code".

## Introduction

Its two siblings, `rubric_based_tool_use_quality_v1` and
`rubric_based_final_response_quality_v1`, grade each invocation on its own. A
property that spans turns cannot be graded that way: the judge sees turn 3 and
has no idea what the user asked in turn 1.

This metric is conversation-level instead. It flattens every invocation into
one plain-text transcript, makes one judge call carrying that transcript, and
attributes the result to the last invocation. The first N-1 invocations report
`NOT_EVALUATED` with no score. That is the expected outcome, not a failure.

Each rubric is one plain-English property of the conversation. The judge
returns one `yes` or `no` verdict for it. A `yes` scores 1.0 and a `no` scores
0.0, so the run scores the mean of the rubrics that were assessed, in `[0, 1]`.
A rubric the judge did not score stays unscored rather than counting as a
failure. A judge is not a stable oracle, so the metric samples it several times
and settles each rubric by majority vote; a tie counts as a `no`.
`overallEvalStatus` compares the mean against the criterion's `threshold`.

`MultiTurnTrajectoryQualityV1Evaluator` scores the same idea through the
Vertex AI Gen AI evaluation service. Reach for that one when you already run
evaluation in a Google Cloud project and want the managed metric. Reach for
this one to run offline against any judge model the registry resolves.

`RubricBasedEvaluator` is the base this metric stands on. It owns the rubric
bookkeeping, reads the verdicts back, and folds them into a score;
`LlmAsJudge` below it owns the sampling and the parallel-call limit.

The class is experimental, so its API may change.

## Get started

The criterion carries the threshold, the rubrics and the judge options. No
golden conversation is needed.

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
          textProperty: 'The agent confirmed the fare before it booked.',
        },
      },
    ],
    judgeModelOptions: {judgeModel: 'gemini-2.5-flash', numSamples: 5},
  },
};

const evaluator = new RubricBasedMultiTurnTrajectoryEvaluator(evalMetric);

const conversation: Invocation[] = [
  {
    userContent: {role: 'user', parts: [{text: 'Find me a flight to Tokyo.'}]},
    finalResponse: {parts: [{text: 'I found three flights.'}]},
  },
  {
    userContent: {role: 'user', parts: [{text: 'Book the first one.'}]},
    finalResponse: {parts: [{text: 'Please confirm the $800 fare.'}]},
  },
  {
    userContent: {role: 'user', parts: [{text: 'Confirmed.'}]},
    finalResponse: {parts: [{text: 'Booked, your code is ABC123.'}]},
  },
];

// `perInvocationResults` has one entry per turn. The first two report
// `NOT_EVALUATED`; the third carries the score, and so does `overallScore`.
const result = await evaluator.evaluateInvocations(conversation);
```

## The transcript the judge reads

`assembleDialogueHistory` builds the transcript, and it is exported so you can
see exactly what the judge will read. Turn numbers are 1-based, and every line
of one invocation carries that invocation's turn number.

| Line                                               | Where it comes from                               |
| -------------------------------------------------- | ------------------------------------------------- |
| `USER TURN n: ...`                                 | The text parts of `userContent`.                  |
| `AGENT (name) TURN n: ...`                         | The text parts of an event or the final response. |
| `AGENT (name) TURN n (tool call): tool({...})`     | A `functionCall` part of an event.                |
| `AGENT (name) TURN n (tool output): tool -> {...}` | A `functionResponse` part of an event.            |

An event authored by `user`, in any case, is written as `USER` rather than
`AGENT (...)`. The final response is attributed to the first event's author, or
to `agent` when the invocation recorded no event.

```ts
import {assembleDialogueHistory} from '@google/adk';

const {dialogue} = assembleDialogueHistory([
  {
    userContent: {role: 'user', parts: [{text: 'What is my balance?'}]},
    finalResponse: {parts: [{text: 'Your balance is $100.'}]},
    intermediateData: {
      invocationEvents: [
        {
          author: 'banking_agent',
          content: {
            parts: [
              {functionCall: {name: 'get_balance', args: {account_id: '123'}}},
            ],
          },
        },
      ],
    },
  },
]);

// USER TURN 1: What is my balance?
// AGENT (banking_agent) TURN 1 (tool call): get_balance({"account_id": "123"})
// AGENT (banking_agent) TURN 1: Your balance is $100.
```

Tool lines are read from `intermediateData` only when it holds invocation
events. A recorded trajectory (`toolUses` / `toolResponses`) contributes no
tool lines, so record events when a rubric names a tool call.

## Instructions and tool declarations

`<agent_system_instructions>` and `<agent_tool_definitions>` come from
`appDetails` on the invocations. Every turn contributes, and the blocks are
de-duplicated keeping first-seen order, so an agent repeated across ten turns
appears once. Set `appDetails` when a rubric names a tool or an instruction;
without it the judge is told nothing about either.

```ts
const appDetails = {
  agentDetails: {
    booking_agent: {
      name: 'booking_agent',
      instructions: 'You book flights and always confirm the fare first.',
      toolDeclarations: [
        {
          functionDeclarations: [
            {name: 'search_flights', description: 'Search for flights.'},
          ],
        },
      ],
    },
  },
};
```

## Add rubrics per invocation

An `Invocation` carries its own `rubrics`, which the metric adds to the
criterion's. Only those whose `type` is `TRAJECTORY_QUALITY` are used, so one
eval case can carry rubrics for several metrics. Because only the last
invocation is judged, put a per-invocation rubric on the last turn.

```ts
const lastTurn: Invocation = {
  userContent: {role: 'user', parts: [{text: 'Confirmed.'}]},
  finalResponse: {parts: [{text: 'Booked, your code is ABC123.'}]},
  rubrics: [
    {
      rubricId: '3',
      rubricContent: {textProperty: 'The agent never booked twice.'},
      type: 'TRAJECTORY_QUALITY',
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

One prompt is built per run however many samples are taken, so raising
`numSamples` costs judge calls but not prompt size.

## What a failure does

One failed judge call never fails the run. If any sample fails, the last
invocation is reported with no score and the status `NOT_EVALUATED`, and so is
the run as a whole. A judge that answers but writes something the metric cannot
read produces the same outcome.

`evaluateInvocations([])` returns an empty result: no score, status
`NOT_EVALUATED`, and no per-invocation entries.

Passing `expectedInvocations` of a different length to `actualInvocations`
throws `InputValidationError`. Golden invocations are otherwise optional; this
metric reports them back on each result but does not grade against them.
