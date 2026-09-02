# EvalCase

An `EvalCase` is one test case for an agent: a conversation to run, the session
to run it in, and the criteria to judge it by. Reach for it when you write eval
data by hand, load an eval set from disk, or build a metric that reads what the
agent did on the way to its answer.

## Introduction

An eval case holds one conversation. The conversation is either static or
simulated, and exactly one of the two is set:

- `conversation` is a list of `Invocation` values. Each invocation carries the
  user message, the expected final response, and `intermediateData`, the route
  the agent took to that response.
- `conversationScenario` is a starting prompt and a plan. A user simulator plays
  the later user turns out, so the case has no fixed user messages.

`intermediateData` also comes in two shapes, and this is the part a metric has
to deal with. Recorded eval data uses `IntermediateData`, which lists the tool
calls and tool responses directly. A case captured from a live run uses
`InvocationEvents`, which keeps the events the agent emitted and leaves the tool
calls inside their parts. The three accessors — `getAllToolCalls`,
`getAllToolResponses` and `getAllToolCallsWithResponses` — read either shape, so
a metric never branches on which one it got.

Rubrics attach at two levels. `Invocation.rubrics` applies to one turn.
`EvalCase.rubrics` applies to every turn in the conversation.

## Get started

```ts
import {
  EvalCase,
  getAllToolCallsWithResponses,
  validateEvalCase,
} from '@google/adk';

const evalCase: EvalCase = {
  evalId: 'weather_lookup',
  creationTimestamp: Date.now() / 1000,
  conversation: [
    {
      userContent: {role: 'user', parts: [{text: 'What is the weather?'}]},
      finalResponse: {role: 'model', parts: [{text: 'It is sunny.'}]},
      intermediateData: {
        toolUses: [{id: 'call1', name: 'search', args: {query: 'weather'}}],
        toolResponses: [
          {id: 'call1', name: 'search', response: {result: 'sunny'}},
        ],
      },
    },
  ],
};

validateEvalCase(evalCase);

const toolPairs = (evalCase.conversation ?? []).flatMap((invocation) =>
  getAllToolCallsWithResponses(invocation.intermediateData),
);
// toolPairs[0] is [{id: 'call1', name: 'search', ...}, {id: 'call1', ...}]
```

`getAllToolCallsWithResponses` pairs each call with the response that carries
the same `id`. A call with no recorded response is paired with `undefined`, so
the list always has one entry per call.

## Extra fields

`EvalCase` and `SessionInput` keep fields they do not declare. Attach your own
metadata to a case, and it survives a load-modify-save cycle:

```ts
const evalCase: EvalCase = {
  evalId: 'weather_lookup',
  creationTimestamp: 0,
  conversation: [],
  owner: 'platform',
};

const reloaded = JSON.parse(JSON.stringify(evalCase)) as EvalCase;
// reloaded['owner'] === 'platform'
```

Every other model in the module rejects an undeclared field, which matches
adk-python.

## Failure modes

Both are reported as `InputValidationError`:

- `validateEvalCase` throws when `conversation` and `conversationScenario` are
  both set, and when neither is. An empty `conversation` array counts as set.
- The three accessors throw when `intermediateData` is neither
  `IntermediateData` nor `InvocationEvents`. An eval-set file written by another
  tool can hold such a value, so the accessors report it instead of returning an
  empty list. An `intermediateData` of `undefined` is not an error: the
  accessors return an empty list.
