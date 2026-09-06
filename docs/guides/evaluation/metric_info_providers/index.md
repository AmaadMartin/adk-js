# Metric info providers

A metric info provider describes one prebuilt eval metric: the name the metric
is configured and reported under, a short description of what it measures, and
the interval its scores fall in. Reach for one when a tool has to present a
metric to a person — a metric picker, an eval report, or a CLI that lists what
it can measure.

## Introduction

`PrebuiltMetrics` names the metrics ADK ships with, but a name is all it is.
`tool_trajectory_avg_score` does not say what it compares, and `0.4` does not
say whether the scale runs to 1 or to 5. A tool that wants to show either has to
carry its own table, and that table drifts from the evaluators.

A provider is that description, kept next to the metric instead of in the tool.
It implements `MetricInfoProvider`, a one-method interface that returns a
`MetricInfo`. The `MetricInfo` carries the metric name, the description, and a
`MetricValueInfo` holding the `Interval` the scores lie in. Both ends of that
interval are closed, because `Interval` reads an absent `openAtMin` or
`openAtMax` as closed.

Each prebuilt metric has exactly one provider that claims it, so a registry
built from the full set never has two entries fighting over one name. Twelve
classes cover the thirteen metrics: `ResponseEvaluatorMetricInfoProvider`
serves two, and takes the metric it describes as a constructor argument.

A provider holds no state and does no I/O. Constructing one costs nothing, and
`getMetricInfo()` returns a fresh object on every call, so a caller may keep,
edit, or serialize the result freely.

## Get started

```ts
import {TrajectoryEvaluatorMetricInfoProvider} from '@google/adk';

const info = new TrajectoryEvaluatorMetricInfoProvider().getMetricInfo();

info.metricName; // 'tool_trajectory_avg_score'
info.metricValueInfo.interval; // {minValue: 0, maxValue: 1}
info.description; // 'This metric compares two tool call trajectories ...'
```

## Choosing the metric at construction time

`ResponseEvaluatorMetricInfoProvider` describes either
`response_evaluation_score` or `response_match_score`. It is the only prebuilt
metric that does not score in `[0, 1]`: `response_evaluation_score` runs from 1
to 5.

```ts
import {
  PrebuiltMetrics,
  ResponseEvaluatorMetricInfoProvider,
} from '@google/adk';

new ResponseEvaluatorMetricInfoProvider(
  PrebuiltMetrics.RESPONSE_EVALUATION_SCORE,
).getMetricInfo().metricValueInfo.interval; // {minValue: 1, maxValue: 5}

new ResponseEvaluatorMetricInfoProvider(
  PrebuiltMetrics.RESPONSE_MATCH_SCORE,
).getMetricInfo().metricValueInfo.interval; // {minValue: 0, maxValue: 1}
```

Any other name is an error. The constructor accepts it, and `getMetricInfo()`
throws an `InputValidationError` naming it. The failure surfaces where the
description is asked for, so a caller may construct a provider for a name it has
not validated yet.

```ts
import {ResponseEvaluatorMetricInfoProvider} from '@google/adk';

const provider = new ResponseEvaluatorMetricInfoProvider('not_a_metric');

provider.getMetricInfo();
// throws InputValidationError: `not_a_metric` is not supported.
```

## The providers

| Class                                                          | Metric                                          | Range    |
| -------------------------------------------------------------- | ----------------------------------------------- | -------- |
| `TrajectoryEvaluatorMetricInfoProvider`                        | `tool_trajectory_avg_score`                     | `[0, 1]` |
| `ResponseEvaluatorMetricInfoProvider`                          | `response_evaluation_score`                     | `[1, 5]` |
| `ResponseEvaluatorMetricInfoProvider`                          | `response_match_score`                          | `[0, 1]` |
| `SafetyEvaluatorV1MetricInfoProvider`                          | `safety_v1`                                     | `[0, 1]` |
| `MultiTurnTaskSuccessV1MetricInfoProvider`                     | `multi_turn_task_success_v1`                    | `[0, 1]` |
| `MultiTurnTrajectoryQualityV1MetricInfoProvider`               | `multi_turn_trajectory_quality_v1`              | `[0, 1]` |
| `MultiTurnToolUseQualityV1MetricInfoProvider`                  | `multi_turn_tool_use_quality_v1`                | `[0, 1]` |
| `FinalResponseMatchV2EvaluatorMetricInfoProvider`              | `final_response_match_v2`                       | `[0, 1]` |
| `RubricBasedFinalResponseQualityV1EvaluatorMetricInfoProvider` | `rubric_based_final_response_quality_v1`        | `[0, 1]` |
| `HallucinationsV1EvaluatorMetricInfoProvider`                  | `hallucinations_v1`                             | `[0, 1]` |
| `RubricBasedToolUseV1EvaluatorMetricInfoProvider`              | `rubric_based_tool_use_quality_v1`              | `[0, 1]` |
| `PerTurnUserSimulatorQualityV1MetricInfoProvider`              | `per_turn_user_simulator_quality_v1`            | `[0, 1]` |
| `RubricBasedMultiTurnTrajectoryMetricInfoProvider`             | `rubric_based_multi_turn_trajectory_quality_v1` | `[0, 1]` |

## Listing every metric

The full set of providers describes every member of `PrebuiltMetrics` once, so
a tool can build its own index from them.

```ts
import {
  FinalResponseMatchV2EvaluatorMetricInfoProvider,
  HallucinationsV1EvaluatorMetricInfoProvider,
  MultiTurnTaskSuccessV1MetricInfoProvider,
  MultiTurnToolUseQualityV1MetricInfoProvider,
  MultiTurnTrajectoryQualityV1MetricInfoProvider,
  PerTurnUserSimulatorQualityV1MetricInfoProvider,
  PrebuiltMetrics,
  ResponseEvaluatorMetricInfoProvider,
  RubricBasedFinalResponseQualityV1EvaluatorMetricInfoProvider,
  RubricBasedMultiTurnTrajectoryMetricInfoProvider,
  RubricBasedToolUseV1EvaluatorMetricInfoProvider,
  SafetyEvaluatorV1MetricInfoProvider,
  TrajectoryEvaluatorMetricInfoProvider,
  type MetricInfo,
  type MetricInfoProvider,
} from '@google/adk';

const providers: MetricInfoProvider[] = [
  new TrajectoryEvaluatorMetricInfoProvider(),
  new ResponseEvaluatorMetricInfoProvider(
    PrebuiltMetrics.RESPONSE_EVALUATION_SCORE,
  ),
  new ResponseEvaluatorMetricInfoProvider(PrebuiltMetrics.RESPONSE_MATCH_SCORE),
  new SafetyEvaluatorV1MetricInfoProvider(),
  new MultiTurnTaskSuccessV1MetricInfoProvider(),
  new MultiTurnTrajectoryQualityV1MetricInfoProvider(),
  new MultiTurnToolUseQualityV1MetricInfoProvider(),
  new FinalResponseMatchV2EvaluatorMetricInfoProvider(),
  new RubricBasedFinalResponseQualityV1EvaluatorMetricInfoProvider(),
  new HallucinationsV1EvaluatorMetricInfoProvider(),
  new RubricBasedToolUseV1EvaluatorMetricInfoProvider(),
  new PerTurnUserSimulatorQualityV1MetricInfoProvider(),
  new RubricBasedMultiTurnTrajectoryMetricInfoProvider(),
];

const byName = new Map<string, MetricInfo>(
  providers
    .map((provider) => provider.getMetricInfo())
    .map((info) => [info.metricName, info]),
);

byName.size; // 13
```

## Parity with adk-python

This module is a port of `google/adk/evaluation/metric_info_providers.py`. The
class names, the metric names, the intervals and the description strings match
it character for character, so a description rendered by either SDK reads the
same. Two things differ, neither observable in a score:

- adk-python raises `ValueError` for an unsupported metric name. adk-js throws
  `InputValidationError`, which is what the rest of this package throws for a
  bad input. The message text is the same.
- adk-python's `Interval` carries `open_at_min` and `open_at_max` as required
  booleans that default to `False`. adk-js carries them as optional, and reads
  an absent value as closed. Both describe a closed interval.
