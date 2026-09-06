# Eval metrics

The eval metrics module holds the vocabulary an evaluation speaks: the metric
names ADK ships with, the criterion a metric is judged against, the options a
judge model reads, and the shape of a metric result. Reach for it when you
write an eval config, when you read an eval result, or when you write an
evaluator of your own.

## Introduction

An evaluation has three parties. The config says what to measure, the evaluator
measures it, and the result reports the measurement. All three need the same
words for the same things, so this module owns those words. An evaluator does
not invent its own criterion shape, and a result stays readable by a tool that
never saw the evaluator.

A metric names what to measure and carries the criterion that decides pass from
fail. Every criterion carries a `threshold`. A metric that prompts a judge model
extends the criterion with `judgeModelOptions`. A metric that scores against
rubrics extends it with `rubrics`. A metric that compares tool calls extends it
with a match type.

The config that carries these values is untrusted text, so each shape has a
`parse` function rather than only a type. A `parse` function applies every
default, accepts both the adk-python spelling (`judge_model_options`) and the
adk-js one (`judgeModelOptions`), and throws an `InputValidationError` naming
the field that is wrong. Its `cause` is the underlying `ZodError`, so a caller
that wants the structured issues can reach them.

One rule differs between the criteria and everything else. A criterion keeps a
key its own shape does not name, because one config file holds criteria for
several metrics and each evaluator reads only its own fields. Every other model
rejects an unrecognized key.

## Get started

```ts
import {
  getMetricThreshold,
  parseEvalMetric,
  parseRubricsBasedCriterion,
  PrebuiltMetrics,
} from '@google/adk';

const criterion = parseRubricsBasedCriterion({
  threshold: 0.7,
  judge_model_options: {judge_model: 'gemini-2.5-pro', parallelism_limit: 4},
  rubrics: [
    {
      rubric_id: 'grammar',
      rubric_content: {text_property: 'The response is grammatically correct.'},
      type: 'FINAL_RESPONSE_QUALITY',
    },
  ],
});

criterion.judgeModelOptions.numSamples; // 5, the default
criterion.includeIntermediateResponsesInFinal; // false, the default

const metric = parseEvalMetric({
  metric_name: PrebuiltMetrics.RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1,
  criterion,
});

getMetricThreshold(metric); // 0.7
```

## Judge model options

`JudgeModelOptions` configures the model a judge-backed metric prompts.
`parseJudgeModelOptions` resolves every field, so downstream code never
re-implements a default.

```ts
import {parseJudgeModelOptions} from '@google/adk';

parseJudgeModelOptions({});
// {judgeModel: 'gemini-2.5-flash', judgeModelConfig: undefined,
//  numSamples: 5, parallelismLimit: 1}
```

`numSamples` defaults to 5 because a model carries a degree of unreliability.
The metric samples the model that many times for one invocation and aggregates
the samples. `parallelismLimit` caps how many of those calls run at once, so it
must be an integer of at least 1.

```ts
parseJudgeModelOptions({parallelismLimit: 0});
// throws InputValidationError:
// Invalid JudgeModelOptions: parallelismLimit: Too small: expected number to be >=1
```

`judgeModelConfig` holds a `GenerateContentConfig` from `@google/genai`. The
schema does not describe it and passes it through by reference.

## Criteria

Each criterion has its own parse function, and each applies its own defaults.

| Criterion                         | Adds                                  | Default             |
| --------------------------------- | ------------------------------------- | ------------------- |
| `BaseCriterion`                   | `includeIntermediateResponsesInFinal` | `false`             |
| `LlmAsAJudgeCriterion`            | `judgeModelOptions`                   | every judge default |
| `RubricsBasedCriterion`           | `rubrics`                             | `[]`                |
| `HallucinationsCriterion`         | `evaluateIntermediateNlResponses`     | `false`             |
| `LlmBackedUserSimulatorCriterion` | `stopSignal`                          | `'</finished>'`     |
| `ToolTrajectoryCriterion`         | `matchType`, `ignoreArgs`             | `EXACT`, `false`    |

A criterion keeps the keys its own shape does not name:

```ts
import {parseBaseCriterion} from '@google/adk';

parseBaseCriterion({threshold: 0.5, rubrics: [{rubric_id: 'g'}]});
// {threshold: 0.5, includeIntermediateResponsesInFinal: false,
//  rubrics: [{rubric_id: 'g'}]}
```

An extra key is kept verbatim, in the spelling the config used. Read it back
through the parse function of the criterion that owns it.

`ToolTrajectoryCriterion.matchType` accepts a loose string, because a config
file writes text rather than an enum member.
`normalizeToolTrajectoryMatchType` trims the string, upper-cases it, and reads
dashes and spaces as underscores.

```ts
import {normalizeToolTrajectoryMatchType} from '@google/adk';

normalizeToolTrajectoryMatchType('in order'); // IN_ORDER
normalizeToolTrajectoryMatchType('ANY-ORDER'); // ANY_ORDER
normalizeToolTrajectoryMatchType(undefined); // EXACT, the field default
normalizeToolTrajectoryMatchType('sideways'); // undefined
```

The function itself never throws. `parseToolTrajectoryCriterion` does, naming
`matchType`, when the function resolves nothing.

## Thresholds

`getMetricThreshold` returns the threshold a metric is judged against. The
criterion threshold wins over the deprecated `EvalMetric.threshold` field that
older configs still carry.

```ts
import {getMetricThreshold} from '@google/adk';

getMetricThreshold({metricName: 'tool_trajectory_avg_score', threshold: 0.4});
// 0.4

getMetricThreshold({metricName: 'tool_trajectory_avg_score'});
// throws InputValidationError:
// Evaluation metric 'tool_trajectory_avg_score' requires a threshold.
```

## The config-declared custom function path

A custom metric names a scoring function. `EvalMetric.customFunctionPath` is a
public field, so whoever built an inbound request can set it. An eval config
file is different: the developer running the evaluation wrote it, so a path it
declares is trusted.

The two are kept apart. A trusted path is recorded outside the metric's own
shape, and `parseEvalMetric` rejects a payload that names it.

```ts
import {
  getConfigCustomFunctionPath,
  parseEvalMetric,
  setConfigCustomFunctionPath,
} from '@google/adk';

const metric = parseEvalMetric({metric_name: 'my_metric', threshold: 0.5});
getConfigCustomFunctionPath(metric); // undefined

setConfigCustomFunctionPath(metric, 'my_package.score');
getConfigCustomFunctionPath(metric); // 'my_package.score'

parseEvalMetric({
  metric_name: 'my_metric',
  threshold: 0.5,
  _config_custom_function_path: 'attacker.score',
});
// throws InputValidationError:
// Invalid EvalMetric: Unrecognized key: "_config_custom_function_path"
```

The path is keyed by the metric object, not by the metric name. Two apps in one
process can declare the same metric name and each still resolves its own
function.

## Describing a metric

A component that owns a metric describes it by implementing
`MetricInfoProvider`. The `MetricInfo` it returns says what the metric measures
and which values it reports, so a user interface can render a score without
knowing the evaluator.

```ts
import {
  PrebuiltMetrics,
  type MetricInfo,
  type MetricInfoProvider,
} from '@google/adk';

class TrajectoryMetricInfoProvider implements MetricInfoProvider {
  getMetricInfo(): MetricInfo {
    return {
      metricName: PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE,
      description: 'Compares the actual tool calls with the expected ones.',
      metricValueInfo: {
        interval: {
          minValue: 0,
          openAtMin: false,
          maxValue: 1,
          openAtMax: false,
        },
      },
    };
  }
}
```

An `Interval` is closed at both ends unless `openAtMin` or `openAtMax` says
otherwise. `parseInterval` fills both flags with `false`, so a descriptor read
from a config file is always fully resolved.

## Results

An `EvalMetricResult` extends the metric it scores, so a result carries the
criterion it was judged against. `evalStatus` is the verdict, `score` is the
value the evaluator computed, and `details` carries the supporting evidence.

```ts
import {parseEvalMetricResult} from '@google/adk';

parseEvalMetricResult({
  metric_name: 'rubric_based_final_response_quality_v1',
  eval_status: 1, // EvalStatus.PASSED
  score: 0.9,
  details: {
    rubric_scores: [
      {rubric_id: 'grammar', rationale: 'It reads well.', score: 1},
    ],
  },
});
```

`score` is absent when the metric was not evaluated, which `EvalStatus` reports
as `NOT_EVALUATED`. `details` defaults to an empty object.

## Relationship to adk-python

The property names are the wire names. adk-python serializes these models with
a camelCase alias generator, so a config file or an eval result written by
either SDK loads in the other. One value does not cross:
`ToolTrajectoryMatchType` carries member names where adk-python's `MatchType`
carries the integers 0, 1 and 2. adk-python reads a name, so a criterion
written here loads there. A criterion adk-python serialized carries an integer
that `normalizeToolTrajectoryMatchType` does not resolve.
