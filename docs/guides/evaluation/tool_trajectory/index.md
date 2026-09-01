# TrajectoryEvaluator

`TrajectoryEvaluator` scores the tool calls an agent made against a golden
list of tool calls. Reach for it when the route to the answer matters: which
tools the agent called, in which order, and with which arguments.

## Introduction

An agent can return the right answer over the wrong route. It can call a
write tool where a read tool was enough, call three tools where one was
enough, or call the right tools in an order that breaks a downstream system.
A metric that only reads the final response cannot see any of that.

This evaluator reads the tool calls of each recorded invocation and compares
them with the tool calls of a golden invocation. Two calls are equal when
their name and their arguments are equal. The call `id` takes no part in the
comparison, because a run assigns it and a golden trajectory cannot predict
it.

It is the `tool_trajectory_avg_score` metric of `adk-python`, and it produces
the same scores. The evaluator is pure: it performs no input or output, and
it does not change the invocations you give it.

## Get started

```ts
import {EvalStatus, TrajectoryEvaluator, type Invocation} from '@google/adk';

const userContent = {parts: [{text: 'What is the weather in Paris?'}]};

const actual: Invocation = {
  userContent,
  intermediateData: {toolUses: [{name: 'get_weather', args: {city: 'Paris'}}]},
};
const expected: Invocation = {
  userContent,
  intermediateData: {toolUses: [{name: 'get_weather', args: {city: 'Paris'}}]},
};

const evaluator = new TrajectoryEvaluator({threshold: 1.0});
const result = evaluator.evaluateInvocations([actual], [expected]);

result.overallScore; // 1
result.overallEvalStatus === EvalStatus.PASSED; // true
```

An invocation can also carry the events a run recorded, rather than a flat
trajectory. The evaluator reads the tool calls out of either shape:

```ts
const fromEvents: Invocation = {
  userContent,
  intermediateData: {
    invocationEvents: [
      {
        author: 'agent',
        content: {
          parts: [{functionCall: {name: 'get_weather', args: {city: 'Paris'}}}],
        },
      },
    ],
  },
};
```

## Match types

The match type decides how strict the comparison is. It defaults to `EXACT`.

| Match type  | What it accepts                                                                  |
| ----------- | -------------------------------------------------------------------------------- |
| `EXACT`     | The same calls in the same order, none extra and none missing.                   |
| `IN_ORDER`  | Every expected call, in the expected order. Extra calls in between are accepted. |
| `ANY_ORDER` | Every expected call, in any order. Extra calls are accepted.                     |

`ANY_ORDER` respects multiplicity: an expected call that repeats needs the
actual trajectory to hold it as many times.

## Configuration from an eval config

A criterion usually arrives as parsed JSON, where the match type is a string.
The evaluator trims it, upper-cases it, and reads a dash or a space as an
underscore, so `'any order'`, `'ANY-ORDER'` and `'any_order'` all resolve.
adk-python normalizes the same spellings, so one eval config drives both.

```ts
import {TrajectoryEvaluator, type BaseCriterion} from '@google/adk';

const criterion: BaseCriterion = JSON.parse(
  '{"threshold": 0.5, "matchType": "any order"}',
);
const evaluator = new TrajectoryEvaluator({
  evalMetric: {metricName: 'tool_trajectory_avg_score', criterion},
});
```

Supply either `threshold` or `evalMetric`, never both. A metric without a
criterion uses its own `threshold` and matches exactly.

## Scores and status

Each invocation scores `1` when its tool calls match, and `0` when they do
not. `overallScore` is the mean over the invocations, and the status is
`PASSED` when that mean is at or above the threshold.

Scoring an empty list evaluates nothing: `overallScore` is absent and the
status is `NOT_EVALUATED`. Bad input throws `InputValidationError`; the
`@throws` tags on the constructor and on `evaluateInvocations` list each case.
