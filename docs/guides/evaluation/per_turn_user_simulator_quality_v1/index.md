# Grading a user simulator

`PerTurnUserSimulatorQualityV1` scores the simulated user in a multi-turn eval
case, turn by turn. Reach for it when a case carries a `ConversationScenario`
instead of a recorded conversation, and you need to know the simulator behaved
before you trust the agent's score.

## Introduction

Most eval metrics grade the agent. This one grades the other side of the
conversation. A case with a `ConversationScenario` has no recorded user turns:
a user simulator writes them at eval time, from a starting prompt, a
conversation plan and an optional persona. If the simulator invents a phone
number, repeats a goal it already completed, or talks past the point where it
should have stopped, the agent's score is measuring the wrong thing.

The metric produces one number for that: the fraction of user turns that were
consistent with the scenario. It grades each turn independently, so a low score
also tells you which turn went wrong.

The first turn is checked without a model. The scenario's `startingPrompt` is
fixed data, so the turn passes when its text matches, ignoring surrounding
whitespace. Every later turn goes to a judge model, which sees the conversation
plan, the transcript up to that turn, the persona and the turn itself. The
judge is asked `numSamples` times and the samples are folded by majority vote;
a tie counts as a rejection.

`LlmAsJudge` is the base class for metrics that grade an agent's response
against a golden one. This metric does not extend it: it grades a turn against
a plan rather than against an expectation, it needs the transcript that
precedes each turn, and it adds a turn of its own. Its helpers are module
functions instead, so you can call any single step directly.

## Get started

An eval config names the metric and its criterion:

```typescript
import {PerTurnUserSimulatorQualityV1} from '@google/adk';

const metric = new PerTurnUserSimulatorQualityV1({
  evalMetric: {
    metricName: 'per_turn_user_simulator_quality_v1',
    criterion: {
      threshold: 0.8,
      stopSignal: '</finished>',
      judgeModelOptions: {judgeModel: 'gemini-2.5-flash', numSamples: 3},
    },
  },
});
```

Then grade a simulated conversation against the scenario that produced it:

```typescript
import type {ConversationScenario, Invocation} from '@google/adk';

const scenario: ConversationScenario = {
  startingPrompt: 'I need to book a flight.',
  conversationPlan:
    'Book a one-way flight from SFO to LAX next Tuesday, under $150. ' +
    'Confirm the booking if the agent finds a valid flight.',
};

const conversation: Invocation[] = [
  {
    userContent: {role: 'user', parts: [{text: 'I need to book a flight.'}]},
    finalResponse: {
      role: 'model',
      parts: [{text: 'Where are you flying from?'}],
    },
  },
  {
    userContent: {
      role: 'user',
      parts: [{text: 'SFO to LAX, next Tuesday please.'}],
    },
    finalResponse: {
      role: 'model',
      parts: [{text: 'I found a 9am flight for $120.'}],
    },
  },
];

const result = await metric.evaluateInvocations(
  conversation,
  undefined,
  scenario,
);
// result.overallScore is the fraction of turns the judge accepted.
// result.perInvocationResults holds one entry per turn.
```

The second argument is the expected invocations every `Evaluator` takes. This
metric never reads it: a simulated user turn has no golden answer.

The judge model is resolved from `LLMRegistry`, so the example above needs
credentials for `gemini-2.5-flash`. Pass `judgeModel` to grade against a model
the registry does not own, which is also how the metric is tested offline.

## The threshold

`criterion.threshold` decides two things. It turns each turn's score into
`PASSED` or `FAILED`, and it turns the overall fraction into
`overallEvalStatus`. A turn scores 1 or 0, so any threshold above 0 makes a
rejected turn fail.

## The stop-signal turn

After grading the real turns, the metric asks the judge one more question:
should this conversation already have ended? It builds a synthetic turn whose
text is `criterion.stopSignal` and grades it against the full transcript.

When that call fails, the metric **replaces** the last result rather than
adding one. A conversation that ran too long is a fault of its last turn, not a
turn of its own, so `perInvocationResults` still has one entry per real turn.
The replaced entry carries the invocation id `stop_signal_proxy_invocation`.

`stopSignal` defaults to `</finished>`. For the best results it matches the
signal your user simulator actually emits.

## Personas

When the scenario carries a `userPersona`, the judge prompt gains a criteria
section built from the persona's behaviors, and the persona's description.

A persona reaches the prompt from a data file or from agent output, so its
fields are not trusted. adk-python renders them with jinja2's
`SandboxedEnvironment`. There is no comparable sandbox for a JavaScript
template engine, so this port substitutes named values and evaluates nothing:

```typescript
import {getPerTurnUserSimulatorQualityPrompt} from '@google/adk';

const prompt = getPerTurnUserSimulatorQualityPrompt({
  conversationPlan: 'plan',
  conversationHistory: 'history',
  generatedUserResponse: 'response',
  stopSignal: '</finished>',
  userPersona: {
    id: 'terse',
    description: 'Answers in as few words as possible.',
    behaviors: [
      {
        name: 'Terse',
        description: 'Never uses two sentences where one will do.',
        behaviorInstructions: ['keep every answer under ten words'],
        violationRubrics: ['wrote more than one sentence'],
      },
    ],
  },
});
```

A persona field may name a value the prompt already carries — `{{ stop_signal }}`
substitutes, matching adk-python. Anything else renders as the empty string. A
call, a subscript or a walk up the prototype chain produces nothing and raises
nothing, where jinja2 would raise `SecurityError`.

## Reading a single step

Every step is a module function, so you can call one without building the
metric:

```typescript
import {
  aggregateSamples,
  convertLlmResponseToScore,
  evaluateFirstTurn,
  formatConversationHistory,
  parseIsValidLabel,
} from '@google/adk';
```

`parseIsValidLabel` reads the `is_valid` verdict out of a judge critique,
`convertLlmResponseToScore` turns one critique into a score,
`aggregateSamples` folds repeated samples by majority vote,
`evaluateFirstTurn` compares a turn against the starting prompt, and
`formatConversationHistory` renders a transcript the way the judge sees it.

## Differences from adk-python

- Sampling is sequential, matching adk-python, so
  `judgeModelOptions.parallelismLimit` does not apply here even though
  `LlmAsJudge` honours it.
- An empty invocation list returns an empty result. adk-python raises an
  `IndexError`.
- adk-python raises `ValueError`; this raises `InputValidationError`.
- An agent reply that names no role is written as `model:` in the transcript.
  adk-python writes the literal `None`.
