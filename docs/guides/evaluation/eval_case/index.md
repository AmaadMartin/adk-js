# EvalCase

An `EvalCase` is one gradable unit of agent evaluation: a conversation to
grade, plus the session it runs in. Reach for it when you record an agent run
for later scoring, or when you write an evaluator that reads a recorded
trajectory.

## Introduction

An eval case is driven in one of two ways, and never both.

- A **recorded conversation** (`conversation`) holds the user turns and the
  agent's replies that were captured on an earlier run. An evaluator replays it
  and scores what the agent did.
- A **conversation scenario** (`conversationScenario`) holds a starting prompt
  and a plan. A user simulator produces the later user turns at eval time.

`validateEvalCase` enforces that choice. A TypeScript interface has no
constructor, so the check that adk-python runs inside its model is an exported
function here. Call it on data you read from a file; it returns the same object
so you can use it inline.

Each turn is an `Invocation`. Its `intermediateData` records the route the agent
took, in one of two shapes: `IntermediateData` for a recorded trajectory, or
`InvocationEvents` for a run replayed from events. The three accessors —
`getAllToolCalls`, `getAllToolResponses` and `getAllToolCallsWithResponses` —
read both shapes, so an evaluator never has to branch on which one it got.

## Get started

```ts
import {
  EvalCase,
  getAllToolCallsWithResponses,
  validateEvalCase,
} from '@google/adk';

const evalCase: EvalCase = validateEvalCase({
  evalId: 'weather_case',
  conversation: [
    {
      userContent: {role: 'user', parts: [{text: 'weather in SFO?'}]},
      intermediateData: {
        toolUses: [{id: 'call1', name: 'get_weather', args: {city: 'SFO'}}],
        toolResponses: [{id: 'call1', name: 'get_weather', response: {f: 61}}],
        intermediateResponses: [],
      },
    },
  ],
});

// [[call, response]] — a call with no matching response pairs with undefined.
getAllToolCallsWithResponses(evalCase.conversation![0].intermediateData);
```

A scenario-driven case carries no conversation at all:

```ts
import {EvalCase, validateEvalCase} from '@google/adk';

const simulated: EvalCase = validateEvalCase({
  evalId: 'booking_case',
  conversationScenario: {
    startingPrompt: 'I need to book a flight.',
    conversationPlan: 'Book SFO to LAX next Tuesday under $150, then confirm.',
  },
});
```

## Pairing calls with responses

`getAllToolCallsWithResponses` returns one entry per tool call, in call order.
It matches each call to the response carrying the same `id`, and pairs a call
that has no match with `undefined`. When two responses share an `id`, the later
one wins. Calls and responses that carry no `id` at all match each other.

## Unknown keys

`SessionInput` and `EvalCase` carry keys they do not declare, so metadata your
pipeline attaches survives a read and a write. Every other model in the module
declares its full set of fields.

```ts
import {EvalCase} from '@google/adk';

const evalCase: EvalCase = {
  evalId: 'case_1',
  conversation: [],
  owner: 'platform',
};

evalCase['owner']; // 'platform'
```

## Failure modes

Both errors are an `InputValidationError`.

- `validateEvalCase` rejects an eval case that sets both `conversation` and
  `conversationScenario`, and one that sets neither. An empty array counts as
  set, so `{evalId, conversation: []}` is valid.
- The three accessors reject `intermediateData` that is present but is neither
  supported shape — an object carrying none of `toolUses`, `toolResponses`,
  `intermediateResponses` or `invocationEvents`, for instance. Absent
  intermediate data is not an error; it returns an empty array.
