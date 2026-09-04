# Metric info providers

A metric info provider describes one prebuilt metric: its wire name, a short
description, and the interval its scores fall in. Reach for one when you list
the metrics an eval run can measure, render a metric in a user interface, or
validate a value a metric reported.

## Introduction

An evaluator scores an invocation. It does not say what its metric means, what
the score range is, or how to label the metric on a screen. That description is
what a metric info provider supplies, and it is separate from the evaluator
because a caller often needs the description without running anything.

The values are shared vocabulary with
[google/adk-python](https://github.com/google/adk-python). The metric name is
the string an eval config writes and an eval result reports, so it must match
across the two SDKs. The description and the interval are the same text and the
same bounds adk-python returns. A tool that lists metrics from either SDK
therefore shows the same thing.

Each metric gets its own provider class rather than one lookup table, so a
metric can grow its own logic without touching the others. Twelve providers
take no argument and describe exactly one metric.
`ResponseEvaluatorMetricInfoProvider` is the exception: it takes a metric name
and describes one of two metrics, because one evaluator in adk-python scores
both.

Every provider returns a fresh object, so a caller that mutates one result
cannot affect the next call. Both interval ends are written explicitly as
closed (`openAtMin: false`, `openAtMax: false`) rather than left undefined, so
a serialized `MetricInfo` carries the same fields adk-python's does.

Most intervals are `[0, 1]`. The exception is `response_evaluation_score`,
which is `[1, 5]`.

## Get started

```ts
import {
  PrebuiltMetrics,
  ResponseEvaluatorMetricInfoProvider,
  TrajectoryEvaluatorMetricInfoProvider,
  type MetricInfo,
} from '@google/adk';

const info: MetricInfo =
  new TrajectoryEvaluatorMetricInfoProvider().getMetricInfo();

info.metricName; // 'tool_trajectory_avg_score'
info.metricValueInfo.interval; // {minValue: 0, openAtMin: false, maxValue: 1, openAtMax: false}
```

`ResponseEvaluatorMetricInfoProvider` needs the metric name, and the two names
it accepts return different intervals:

```ts
const coherence = new ResponseEvaluatorMetricInfoProvider(
  PrebuiltMetrics.RESPONSE_EVALUATION_SCORE,
).getMetricInfo();

coherence.metricValueInfo.interval; // {minValue: 1, openAtMin: false, maxValue: 5, openAtMax: false}

const match = new ResponseEvaluatorMetricInfoProvider(
  PrebuiltMetrics.RESPONSE_MATCH_SCORE,
).getMetricInfo();

match.metricValueInfo.interval; // {minValue: 0, openAtMin: false, maxValue: 1, openAtMax: false}
```

## Failure modes

`ResponseEvaluatorMetricInfoProvider` accepts any string. It checks the name
when you call `getMetricInfo()`, not when you construct it, so a provider built
from configuration fails where you read it, not where you build it:

```ts
import {ResponseEvaluatorMetricInfoProvider} from '@google/adk';

const provider = new ResponseEvaluatorMetricInfoProvider('nope'); // does not throw

provider.getMetricInfo(); // throws InputValidationError: `nope` is not supported.
```

Every other provider takes no argument and cannot fail.

## The metrics they describe

| Provider                                                       | Metric name                                     | Interval |
| -------------------------------------------------------------- | ----------------------------------------------- | -------- |
| `TrajectoryEvaluatorMetricInfoProvider`                        | `tool_trajectory_avg_score`                     | [0, 1]   |
| `ResponseEvaluatorMetricInfoProvider`                          | `response_evaluation_score`                     | [1, 5]   |
| `ResponseEvaluatorMetricInfoProvider`                          | `response_match_score`                          | [0, 1]   |
| `SafetyEvaluatorV1MetricInfoProvider`                          | `safety_v1`                                     | [0, 1]   |
| `MultiTurnTaskSuccessV1MetricInfoProvider`                     | `multi_turn_task_success_v1`                    | [0, 1]   |
| `MultiTurnTrajectoryQualityV1MetricInfoProvider`               | `multi_turn_trajectory_quality_v1`              | [0, 1]   |
| `MultiTurnToolUseQualityV1MetricInfoProvider`                  | `multi_turn_tool_use_quality_v1`                | [0, 1]   |
| `FinalResponseMatchV2EvaluatorMetricInfoProvider`              | `final_response_match_v2`                       | [0, 1]   |
| `RubricBasedFinalResponseQualityV1EvaluatorMetricInfoProvider` | `rubric_based_final_response_quality_v1`        | [0, 1]   |
| `HallucinationsV1EvaluatorMetricInfoProvider`                  | `hallucinations_v1`                             | [0, 1]   |
| `RubricBasedToolUseV1EvaluatorMetricInfoProvider`              | `rubric_based_tool_use_quality_v1`              | [0, 1]   |
| `PerTurnUserSimulatorQualityV1MetricInfoProvider`              | `per_turn_user_simulator_quality_v1`            | [0, 1]   |
| `RubricBasedMultiTurnTrajectoryMetricInfoProvider`             | `rubric_based_multi_turn_trajectory_quality_v1` | [0, 1]   |

The thirteen names are exactly the members of `PrebuiltMetrics`, and no two
providers claim the same one.
