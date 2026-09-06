# TrajectoryEvaluator

`TrajectoryEvaluator` scores the tools an agent called against the tools you
expected it to call. Reach for it when you care about _what the agent did_, and
not about the words it answered with.

## Introduction

An agent run produces two things a test can look at: the final text, and the
trajectory of tool calls that produced it. The text is hard to assert on, so
regressions in tool use often hide behind a plausible answer. This metric looks
only at the trajectory.

It scores one invocation at a time. An invocation scores `1.0` when its tool
calls match the golden ones under the configured match type, and `0.0`
otherwise. The metric result carries the mean of those scores plus the
per-invocation breakdown, so a failing eval case tells you which turn broke.

Three knobs decide what "match" means:

- `matchType` chooses how strict the comparison is.
- `ignoreArgs` drops the arguments from the comparison, leaving tool names.
- `threshold` is the score at or above which the metric passes.

The tool call `id` never takes part in the comparison. A run assigns it, so a
golden trajectory cannot predict it.

## Get started

```ts
import {
  EvalStatus,
  ToolTrajectoryMatchType,
  TrajectoryEvaluator,
  type Invocation,
} from '@google/adk';

const evaluator = new TrajectoryEvaluator({
  evalMetric: {
    metricName: 'tool_trajectory_avg_score',
    criterion: {threshold: 1.0, matchType: ToolTrajectoryMatchType.EXACT},
  },
});

const actual: Invocation[] = [
  {
    userContent: {parts: [{text: 'What is the weather in Paris?'}]},
    intermediateData: {
      toolUses: [{name: 'get_weather', args: {city: 'Paris'}}],
    },
  },
];
const expected: Invocation[] = [
  {
    userContent: {parts: [{text: 'What is the weather in Paris?'}]},
    intermediateData: {
      toolUses: [{name: 'get_weather', args: {city: 'Paris'}}],
    },
  },
];

const result = evaluator.evaluateInvocations(actual, expected);
result.overallScore; // 1.0
result.overallEvalStatus === EvalStatus.PASSED; // true
```

Pass a plain `threshold` instead of a metric when you want the default match
type and no config file:

```ts
const evaluator = new TrajectoryEvaluator({threshold: 0.5});
```

Supply one of the two. Supplying both, or neither, throws
`InputValidationError`.

## Match types

| Match type  | What it accepts                                                              |
| ----------- | ---------------------------------------------------------------------------- |
| `EXACT`     | The same calls, in the same order, with none extra and none missing.         |
| `IN_ORDER`  | Every expected call, in the expected order. Extra calls in between are fine. |
| `ANY_ORDER` | Every expected call, in any order, respecting repeats. Extra calls are fine. |

`EXACT` is the default. A criterion read from a config file may spell the match
type as a string, and the spelling is forgiving: `'in order'`, `'IN-ORDER'` and
`'in_order'` all resolve to `IN_ORDER`.

`ANY_ORDER` consumes each call it matches, so an expected call that appears
twice needs the agent to have made it twice.

## Ignoring arguments

Set `ignoreArgs` to compare tool names only. Use it when the agent is free to
phrase a query its own way, and you only want to pin which tools it reached
for.

```ts
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

## Reading the result

`evaluateInvocations` returns an `EvaluationResult`:

- `overallScore` — the mean of the per-invocation scores. Absent when there was
  nothing to score.
- `overallEvalStatus` — `PASSED` at or above the threshold, `FAILED` below it,
  and `NOT_EVALUATED` when the invocation list was empty.
- `perInvocationResults` — one entry per invocation, each carrying the actual
  invocation, the golden one, its score and its status.

The evaluator never mutates the invocations you hand it.

## Errors

Every rejection throws `InputValidationError`:

- the constructor gets both a `threshold` and an `evalMetric`, or neither;
- the metric carries a criterion the metric cannot read — a missing threshold,
  an unknown match type, or a non-boolean `ignoreArgs`;
- the metric carries neither a criterion nor a threshold;
- `evaluateInvocations` is called without `expectedInvocations`, or with lists
  of different lengths.

## Parity

This metric mirrors `src/google/adk/evaluation/trajectory_evaluator.py` in
[google/adk-python](https://github.com/google/adk-python). Enum string values,
default values and error message text follow the Python implementation, so an
eval config scores the same in both runtimes. Property names follow TypeScript
convention: a criterion accepts `matchType` and `ignoreArgs`, and also the
`match_type` and `ignore_args` spellings a Python-authored config carries.

One behaviour differs on purpose: a call with no `args` compares equal to one
with empty `args`. Python compares the raw fields, where `None` and `{}`
differ.
