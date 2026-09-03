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
const trajectory = {
  toolUses: [{name: 'get_weather', args: {city: 'Paris'}}],
  toolResponses: [],
  intermediateResponses: [],
};

const actual: Invocation = {
  invocationId: 'run-1',
  userContent,
  intermediateData: trajectory,
  creationTimestamp: 0,
};
const expected: Invocation = {
  invocationId: 'golden-1',
  userContent,
  intermediateData: trajectory,
  creationTimestamp: 0,
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
  invocationId: 'run-2',
  creationTimestamp: 0,
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

## Ignoring arguments

Set `ignoreArgs` to compare tool names only. Use it when the agent is free to
phrase a query its own way, and you only want to pin which tools it reached
for.

```ts
import {ToolTrajectoryMatchType, TrajectoryEvaluator} from '@google/adk';

const evaluator = new TrajectoryEvaluator({
  evalMetric: {
    metricName: 'tool_trajectory_avg_score',
    criterion: {
      threshold: 1.0,
      matchType: ToolTrajectoryMatchType.ANY_ORDER,
      ignoreArgs: true,
    },
  },
});
```

`ignoreArgs` applies to all three match types, and defaults to `false`.

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

A criterion also accepts the `match_type` and `ignore_args` spellings a
Python-authored config carries.

Supply either `threshold` or `evalMetric`, never both. A metric without a
criterion uses its own `threshold` and matches exactly.

## Scores and status

Each invocation scores `1` when its tool calls match, and `0` when they do
not. `overallScore` is the mean over the invocations, and the status is
`PASSED` when that mean is at or above the threshold.

Scoring an empty list evaluates nothing: `overallScore` is absent and the
status is `NOT_EVALUATED`.

`perInvocationResults` holds one entry per invocation, each carrying the
actual invocation, the golden one, its score and its status. The evaluator
never mutates the invocations you hand it.

## Errors

Every rejection throws `InputValidationError`:

- the constructor gets both a `threshold` and an `evalMetric`, or neither;
- the metric carries a criterion the metric cannot read — a missing threshold,
  an unknown match type, or a non-boolean `ignoreArgs`;
- the metric carries neither a criterion nor a threshold;
- `evaluateInvocations` is called without `expectedInvocations`, or with lists
  of different lengths.

The metric names the criterion type it accepts in
`TrajectoryEvaluator.criterionType`, and a rejected criterion says why in the
message.

## Parity

This metric mirrors `src/google/adk/evaluation/trajectory_evaluator.py` in
[google/adk-python](https://github.com/google/adk-python). Enum string values
and default values follow the Python implementation, so an eval config scores
the same in both runtimes.

One behaviour differs on purpose: a call with no `args` compares equal to one
with empty `args`. Python compares the raw fields, where `None` and `{}`
differ.
