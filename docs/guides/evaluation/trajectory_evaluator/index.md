# TrajectoryEvaluator

`TrajectoryEvaluator` scores the tool calls an agent made against the tool calls
a golden recording expected. Reach for it when you want a regression test that
pins _how_ an agent reached its answer, not only what it answered.

## Introduction

A final answer can be right for the wrong reasons. An agent that guesses a
plausible number without calling `roll_die` produces the same text as an agent
that calls the tool correctly, and a test on the text alone cannot tell them
apart. The tool trajectory is the observable part of the reasoning, so pinning
it catches a regression that a text assertion misses.

The evaluator implements the `Evaluator` interface, which is the seam every
metric in ADK sits behind. A metric takes a list of actual `Invocation` objects
and a list of expected ones, and returns an `EvaluationResult`: one
`PerInvocationResult` per pair, plus an overall score and an `EvalStatus`. Write
your own metric by implementing the same interface.

Comparison is per invocation. Each invocation scores exactly 1.0 or 0.0, and the
overall score is the mean. A score at or above the threshold passes, so a
threshold of `0.5` over two invocations passes when one of the two matches.

Two tool calls are equal when their `name` and `args` are equal. The call `id`
takes no part: the runtime assigns it per run, so a golden recording cannot
predict it.

## Get started

The actual trajectory comes from a real run. `getFunctionCalls` turns the
session events into the list of calls the agent made.

```ts
import {
  EvalStatus,
  FunctionTool,
  getFunctionCalls,
  InMemoryRunner,
  Invocation,
  LlmAgent,
  TrajectoryEvaluator,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import {z} from 'zod';

const APP_NAME = 'dice_app';
const USER_ID = 'user-1';

const rollDie = new FunctionTool({
  name: 'roll_die',
  description: 'Rolls a die with the given number of sides.',
  parameters: z.object({sides: z.number()}),
  execute: ({sides}) => ({result: 1 + Math.floor(Math.random() * sides)}),
});

const agent = new LlmAgent({
  name: 'dice_agent',
  instruction: 'Call roll_die when the user asks for a die roll.',
  tools: [rollDie],
});

const runner = new InMemoryRunner({agent, appName: APP_NAME});
const session = await runner.sessionService.createSession({
  appName: APP_NAME,
  userId: USER_ID,
});

const newMessage = createUserContent('Roll a 16 sided die');
for await (const _ of runner.runAsync({
  userId: USER_ID,
  sessionId: session.id,
  newMessage,
})) {
  // Drive the run to completion; the events are read back below.
}

const finished = await runner.sessionService.getSession({
  appName: APP_NAME,
  userId: USER_ID,
  sessionId: session.id,
});

const actual: Invocation = {
  userContent: newMessage,
  intermediateData: {toolUses: finished!.events.flatMap(getFunctionCalls)},
};
const expected: Invocation = {
  userContent: newMessage,
  intermediateData: {toolUses: [{name: 'roll_die', args: {sides: 16}}]},
};

const result = new TrajectoryEvaluator({threshold: 1.0}).evaluateInvocations(
  [actual],
  [expected],
);

result.overallScore; // 1.0
result.overallEvalStatus === EvalStatus.PASSED; // true
```

## Choosing a match type

`matchType` decides how strict the comparison is. It defaults to `EXACT`.

| Match type  | What it accepts                                                                      |
| ----------- | ------------------------------------------------------------------------------------ |
| `EXACT`     | The same calls in the same order, with none extra and none missing.                  |
| `IN_ORDER`  | Every expected call, in the same relative order. Extra calls in between are allowed. |
| `ANY_ORDER` | Every expected call, in any order. Extra calls are allowed.                          |

`IN_ORDER` suits an agent whose key steps must happen in sequence, but which may
call other tools along the way. `ANY_ORDER` suits an agent that issues several
independent calls, such as five searches whose order does not matter.

`ANY_ORDER` respects multiplicity. An expected trajectory of `[t1, t2, t1]` needs
the actual trajectory to hold `t1` twice, so `[t1, t2, t3]` fails.

```ts
import {ToolTrajectoryMatchType, TrajectoryEvaluator} from '@google/adk';

const evaluator = new TrajectoryEvaluator({
  threshold: 1.0,
  matchType: ToolTrajectoryMatchType.IN_ORDER,
});
```

When the match type arrives as a string, from a config file for instance,
`parseToolTrajectoryMatchType` resolves it. It ignores case, surrounding blanks,
hyphens and spaces, so `ANY ORDER`, `any-order` and `any_order` all resolve to
`ToolTrajectoryMatchType.ANY_ORDER`. A string that names no match type raises
`InputValidationError`.

## What the result contains

`perInvocationResults` holds one entry per pair, in input order. Each entry
carries both invocations, the score, and its own status against the same
threshold, so you can report which turn regressed.

`evaluateInvocations` raises `InputValidationError` when `expectedInvocations` is
missing, and when the two lists have different lengths. Scoring an empty pair of
lists is not an error: it returns an undefined `overallScore` and an
`overallEvalStatus` of `NOT_EVALUATED`.

An invocation with no `intermediateData` counts as an invocation with no tool
calls, so two such invocations match. An omitted `args` and an empty `args` are
equal.
