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

The config that carries these values is untrusted text, so each shape also has
a `parse` function. A `parse` function applies every default, accepts both the
adk-python spelling (`judge_model_options`) and the adk-js one
(`judgeModelOptions`), and throws an `InputValidationError` naming the field
that is wrong. Its `cause` is the underlying `ZodError`, so a caller that wants
the structured issues can reach them.

One rule differs between the criteria and everything else. A criterion keeps a
key its own shape does not name, because one config file holds criteria for
several metrics and each evaluator reads only its own fields. Every other model
rejects an unrecognized key.

The property names here are the wire names. `adk-python` serializes these
models with a camelCase alias generator, so the property names of a config
file or an eval result match in either SDK. One value does not:
`ToolTrajectoryMatchType` carries member names where `adk-python` carries the
integers 0, 1 and 2. `adk-python` reads a name, so a criterion written here
loads there, but a criterion `adk-python` serialized carries an integer this
SDK does not resolve.

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

## Reading a config file

A config file writes the adk-python spelling and omits every default. The
`parse` functions read it and fill the rest in.

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

criterion.judgeModelOptions?.numSamples; // 5, the default
criterion.includeIntermediateResponsesInFinal; // false, the default

const metric = parseEvalMetric({
  metric_name: PrebuiltMetrics.RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1,
  criterion,
});

getMetricThreshold(metric); // 0.7
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
`JudgeModelOptions` constructor. `parseJudgeModelOptions` does the same for a
raw payload, and accepts the adk-python spelling of each field.

```ts
resolveJudgeModelOptions();
// {judgeModel: 'gemini-2.5-flash', judgeModelConfig: undefined,
//  numSamples: 5, parallelismLimit: 1}

resolveJudgeModelOptions({parallelismLimit: 0});
// throws InputValidationError:
// judgeModelOptions.parallelismLimit must be at least 1, but got 0.

parseJudgeModelOptions({judge_model: 'gemini-2.5-pro', num_samples: 3});
// {judgeModel: 'gemini-2.5-pro', judgeModelConfig: undefined,
//  numSamples: 3, parallelismLimit: 1}

parseJudgeModelOptions({parallelismLimit: 0});
// throws InputValidationError:
// Invalid JudgeModelOptions: parallelismLimit: Too small: expected number to be >=1
```

`numSamples` defaults to 5 because a model carries a degree of unreliability.
The metric samples the model that many times for one invocation and aggregates
the samples. `parallelismLimit` caps how many of those calls run at once, so it
must be at least 1. Both must be integers.

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

## Tool trajectory match types

`ToolTrajectoryCriterion.matchType` is a `ToolTrajectoryMatchType`. A config
file writes a string instead, so a loader reads that string through
`normalizeToolTrajectoryMatchType` first. The function trims the string,
upper-cases it, and reads dashes and spaces as underscores.

```ts
import {normalizeToolTrajectoryMatchType} from '@google/adk';

normalizeToolTrajectoryMatchType('in order'); // IN_ORDER
normalizeToolTrajectoryMatchType('ANY-ORDER'); // ANY_ORDER
normalizeToolTrajectoryMatchType(undefined); // EXACT, the field default
normalizeToolTrajectoryMatchType('nonsense'); // undefined
```

It never throws. An unrecognized value reads as `undefined`, and the caller
decides what to do about it. `parseToolTrajectoryCriterion` does throw, naming
`matchType`, when the function resolves nothing.

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

`parseEvalMetricResult` reads the same result from a stored payload.

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

`score` is absent when the metric was not evaluated, which `EvalStatus`
reports as `NOT_EVALUATED`. `details` defaults to an empty object.

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
otherwise. `parseInterval` fills both flags with `false`, so a descriptor read
from a config file is always fully resolved.
