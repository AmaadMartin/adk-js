# Eval metrics

The eval metrics module holds the vocabulary an evaluation speaks: the metric
names ADK ships with, the criterion a metric is judged against, the options a
judge model reads, and the shape of a metric result. Reach for it when you
write an eval config, when you read an eval result, or when you write an
evaluator of your own.

## Introduction

An evaluation has three parties: the config that says what to measure, the
evaluator that measures it, and the result that reports the measurement. Each
party needs the same words for the same things. This module holds those words,
so an evaluator does not invent its own criterion shape and a result stays
readable by a tool that never saw the evaluator.

A metric names what to measure and carries the criterion that decides pass
from fail. The criterion always carries a `threshold`. A metric that prompts a
judge model extends the criterion with `judgeModelOptions`; a metric that
scores against rubrics extends it with `rubrics`; a metric that compares tool
calls extends it with a match type. An evaluator reads only the fields its own
criterion names, so one config can carry criteria for several metrics.

The property names here are the wire names. `adk-python` serializes these
models with a camelCase alias generator, so a config file or an eval result
written by either SDK reads in the other one.

## Get started

```ts
import {
  getMetricThreshold,
  PrebuiltMetrics,
  resolveJudgeModelOptions,
  type EvalMetric,
  type RubricsBasedCriterion,
} from '@google/adk';

const criterion: RubricsBasedCriterion = {
  threshold: 0.8,
  includeIntermediateResponsesInFinal: true,
  judgeModelOptions: {judgeModel: 'gemini-2.5-pro', parallelismLimit: 4},
  rubrics: [
    {
      rubricId: 'r1',
      rubricContent: {textProperty: 'The answer cites a source.'},
    },
  ],
};

const metric: EvalMetric = {
  metricName: PrebuiltMetrics.RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1,
  criterion,
};

getMetricThreshold(metric); // 0.8
resolveJudgeModelOptions(criterion.judgeModelOptions).numSamples; // 5
```

## Thresholds

`getMetricThreshold` returns the threshold a metric is judged against. The
criterion threshold wins over the deprecated `EvalMetric.threshold` field,
which older configs still carry. A metric that names neither is rejected with
an `InputValidationError`.

```ts
getMetricThreshold({metricName: 'tool_trajectory_avg_score', threshold: 0.4});
// 0.4

getMetricThreshold({metricName: 'tool_trajectory_avg_score'});
// throws InputValidationError:
// Evaluation metric 'tool_trajectory_avg_score' requires a threshold.
```

## Judge model options

`JudgeModelOptions` makes every field optional, so a config names only what it
overrides. `resolveJudgeModelOptions` applies the defaults and rejects values
a judge cannot honour, which is the work `adk-python` does in the
`JudgeModelOptions` constructor.

```ts
resolveJudgeModelOptions();
// {judgeModel: 'gemini-2.5-flash', judgeModelConfig: undefined,
//  numSamples: 5, parallelismLimit: 1}

resolveJudgeModelOptions({parallelismLimit: 0});
// throws InputValidationError:
// judgeModelOptions.parallelismLimit must be at least 1, but got 0.
```

`numSamples` defaults to 5 because a model carries a degree of unreliability.
The metric samples the model that many times for one invocation and aggregates
the samples. `parallelismLimit` caps how many of those calls run at once, so it
must be at least 1. Both must be integers.

## Tool trajectory match types

A tool trajectory criterion accepts its match type as the
`ToolTrajectoryMatchType` enum or as a string, because a config file writes a
string. `normalizeToolTrajectoryMatchType` reads either. It trims the string,
upper-cases it, and reads dashes and spaces as underscores.

```ts
import {normalizeToolTrajectoryMatchType} from '@google/adk';

normalizeToolTrajectoryMatchType('in order'); // IN_ORDER
normalizeToolTrajectoryMatchType('ANY-ORDER'); // ANY_ORDER
normalizeToolTrajectoryMatchType(undefined); // EXACT, the field default
normalizeToolTrajectoryMatchType('nonsense'); // undefined
```

It never throws. An unrecognized value reads as `undefined`, and the caller
decides what to do about it.

## Results

An `EvalMetricResult` extends the metric it scores, so a result carries the
criterion it was judged against. `evalStatus` is the verdict, `score` is the
value the evaluator computed, and `details` carries supporting evidence such
as the per-rubric scores.

```ts
import {EvalStatus, type EvalMetricResult} from '@google/adk';

const result: EvalMetricResult = {
  metricName: 'rubric_based_final_response_quality_v1',
  criterion: {threshold: 0.8},
  score: 0.9,
  evalStatus: EvalStatus.PASSED,
  details: {
    rubricScores: [{rubricId: 'r1', rationale: 'It cites one.', score: 1}],
  },
};
```

`score` is absent when the metric was not evaluated, which `EvalStatus`
reports as `NOT_EVALUATED`.

## Describing a metric

A component that owns a metric describes it by implementing
`MetricInfoProvider`. The `MetricInfo` it returns tells a caller what the
metric measures and which values it can report, so a user interface can render
a score without knowing the evaluator.

```ts
import {PrebuiltMetrics, type MetricInfoProvider} from '@google/adk';

const provider: MetricInfoProvider = {
  getMetricInfo: () => ({
    metricName: PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE,
    description: 'Compares the actual tool calls with the expected ones.',
    metricValueInfo: {interval: {minValue: 0, maxValue: 1}},
  }),
};
```

An `Interval` is closed at both ends unless `openAtMin` or `openAtMax` says
otherwise.

## The scoring function path a config declares

A custom metric names its scoring function. `EvalMetric.customFunctionPath` is
the public field, and whoever writes the payload sets it. The path an eval
config declared is kept apart, in a table this module owns:

```ts
import {
  getConfigCustomFunctionPath,
  setConfigCustomFunctionPath,
  type EvalMetric,
} from '@google/adk';

const metric: EvalMetric = {metricName: 'my_metric', threshold: 0.5};

setConfigCustomFunctionPath(metric, 'my_module.score');
getConfigCustomFunctionPath(metric); // 'my_module.score'
```

The table is a `WeakMap` keyed by the metric object, so a metric parsed from an
inbound payload cannot carry a path: `JSON.parse` reaches object properties and
nothing else. That is the property `adk-python` gets from a pydantic
`PrivateAttr`. Passing `undefined` clears the recorded path, and an entry is
collected together with its metric.
