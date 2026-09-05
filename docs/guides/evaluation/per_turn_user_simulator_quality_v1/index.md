# Grading the user simulator

`PerTurnUserSimulatorQualityV1` grades the simulated user, not the agent. Reach
for it when a multi-turn eval case is driven by a `ConversationScenario` and a
poor score could mean either a poor agent or a simulator that went off plan.

## Introduction

A simulated eval case gives the simulator a `startingPrompt` and a
`conversationPlan`, and the simulator writes every user turn from there. When
the case scores badly, the score alone does not say which side was at fault.
This metric answers that question by grading the simulator's own turns.

It checks three things. The first user turn must be the scenario's
`startingPrompt`, compared as text with the surrounding whitespace ignored.
Every later turn must keep to the conversation plan, which a judge model
decides. And the conversation must have stopped when it should have, which the
metric checks by asking the judge to grade one extra synthetic turn holding the
stop signal.

A judge model grades every turn except the first. The metric samples the judge
`numSamples` times per turn and folds the samples by majority vote, so one
unlucky sample does not decide a turn. A tie counts as invalid. The overall
score is the fraction of turns the judge accepted, and the metric passes when
that fraction reaches the criterion's `threshold`.

adk-python registers this metric in its metric evaluator registry. adk-js has
no such registry yet, so construct the metric directly.

## Get started

```typescript
import {
  EvalStatus,
  PerTurnUserSimulatorQualityV1,
  type ConversationScenario,
  type EvalMetric,
  type Invocation,
} from '@google/adk';

const metric: EvalMetric = {
  metricName: 'per_turn_user_simulator_quality_v1',
  criterion: {
    threshold: 0.8,
    stopSignal: '</finished>',
    judgeModelOptions: {judgeModel: 'gemini-2.5-flash', numSamples: 3},
  },
};

const scenario: ConversationScenario = {
  startingPrompt: 'I need to book a flight.',
  conversationPlan:
    'Book a one-way flight from SFO to LAX for next Tuesday, then confirm it.',
};

const conversation: Invocation[] = [
  {
    userContent: {role: 'user', parts: [{text: 'I need to book a flight.'}]},
    finalResponse: {role: 'model', parts: [{text: 'Where are you flying?'}]},
  },
  {
    userContent: {role: 'user', parts: [{text: 'SFO to LAX, next Tuesday.'}]},
    finalResponse: {
      role: 'model',
      parts: [{text: 'I found a morning flight.'}],
    },
  },
];

const evaluator = new PerTurnUserSimulatorQualityV1(metric);
const result = await evaluator.evaluateInvocations(
  conversation,
  /* expectedInvocations= */ undefined,
  scenario,
);

// `overallScore` is the fraction of turns the judge accepted, and
// `overallEvalStatus` is `EvalStatus.PASSED` when it reaches the threshold.
const keptToThePlan = result.overallEvalStatus === EvalStatus.PASSED;
```

`result.perInvocationResults` holds one entry per turn, in turn order. The last
entry is replaced by the stop-signal result when the conversation failed to
stop, and its `actualInvocation.invocationId` is then
`stop_signal_proxy_invocation`.

## Configuration

The criterion is an `LlmBackedUserSimulatorCriterion`.

| Field                                | Default            | What it does                                                                       |
| ------------------------------------ | ------------------ | ---------------------------------------------------------------------------------- |
| `threshold`                          | required           | The fraction of accepted turns the case must reach to pass.                        |
| `stopSignal`                         | `</finished>`      | The token that marks the conversation complete. Match the one the simulator emits. |
| `judgeModelOptions.judgeModel`       | `gemini-2.5-flash` | The model that grades a turn.                                                      |
| `judgeModelOptions.numSamples`       | `5`                | Judge calls per turn.                                                              |
| `judgeModelOptions.judgeModelConfig` | none               | Generation config passed to the judge.                                             |

The constructor rejects a metric that carries no criterion, and a criterion the
schema refuses, with `InputValidationError`. A refused criterion carries the
schema error as its `cause`.

Pass your own judge model to grade offline or against a model the registry does
not resolve:

```typescript
const evaluator = new PerTurnUserSimulatorQualityV1(metric, {judgeModel});
```

## Personas

A scenario may name a `userPersona`. The metric then builds the judge prompt
from the persona template, so the judge grades each of the persona's behaviors
as its own criterion instead of grading the fixed default criteria.

Persona text is rendered before it reaches the judge, so a behavior may refer to
`{{ stop_signal }}` and the other prompt variables. The renderer substitutes a
plain dotted path and repeats the behaviors block, and it compiles and evaluates
nothing: any other expression renders as the empty string, and a substituted
value is never rescanned. Persona text is untrusted, because it is usually read
from a data file.

## Differences from adk-python

- An empty invocation list returns an empty result. adk-python indexes the
  first invocation unguarded and raises `IndexError`.
- A response whose content names no role is written as `model:` in the
  conversation history. adk-python writes the literal `None:`.
- Rejected input raises `InputValidationError`, which extends `Error`.
  adk-python raises `ValueError`.
- A judge that answers nothing scores the turn `NOT_EVALUATED`, matching
  adk-python. `LlmAsJudge` throws in the same situation.
- `judgeModelOptions.parallelismLimit` is accepted and ignored. Turn _i_ is
  judged against turns 0 to _i-1_, so the turns are sequential by construction.
- adk-python renders persona text through a Jinja2 sandbox and raises
  `SecurityError` on an expression that escapes it. The renderer here compiles
  nothing, so there is no sandbox to escape and no error to raise.
