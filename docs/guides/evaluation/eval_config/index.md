# Eval config

An eval config is the `test_config.json` beside an eval set. It says which
metrics to score, which of them your own code scores, which user simulator
drives the conversation, and how long a live model turn may take. Reach for it
when you set up an evaluation, and when you want the same config file to run
under adk-js and adk-python.

## Introduction

An eval run needs three things before it can score anything: the criteria, the
metrics those criteria name, and the settings the run itself needs. The eval
config carries all three in one document, so a test folder is self-describing
and a run takes a path rather than a pile of options.

`criteria` maps a metric name to the criterion that metric is judged against. A
criterion is a bare number, which is the threshold, or an object for a metric
that needs more than a threshold. The metric names are chosen by whoever wrote
the config, so they are never rewritten; every other key loads in either
casing, because adk-python aliases these fields to camelCase and populates by
name as well. `custom_metrics` and `customMetrics` therefore both load, and so
does `liveModelConfig.timeoutSeconds` beside `live_model_config.timeout_seconds`.

`customMetrics` declares a metric that your own code scores. Its `codeConfig`
names the scoring function, and its optional `metricInfo` says what the metric
measures and the range it reports. `getEvalMetricsFromConfig` turns the
criteria into the metrics an eval run scores, and records each custom function
path on the metric it belongs to rather than in a registry keyed by name, so
two apps in one process can declare the same metric name and each still
resolves its own function.

`userSimulatorConfig` selects a user simulator through a `type` discriminator.
A config written before that field existed is read as `'llm_backed'`, and the
parser says so at info level. This package models the simulator configuration
only; the simulators that read it are not ported yet.

Every invalid document raises `InputValidationError`. That covers a criterion
that is neither a threshold nor an object carrying one, a `codeConfig` with an
unknown key, a `type` that names no simulator, and custom instructions that
omit a required placeholder. An absent config file is not an error:
`getEvaluationCriteriaOrDefault` returns `DEFAULT_EVAL_CONFIG`, which scores
`tool_trajectory_avg_score` at 1.0 and `response_match_score` at 0.8. A file
that exists but cannot be read propagates its error.

## Get started

Write a `test_config.json` beside the eval set:

```json
{
  "criteria": {
    "tool_trajectory_avg_score": 1.0,
    "final_response_match_v2": {
      "threshold": 0.5,
      "judge_model_options": {"judge_model": "gemini-2.5-pro", "num_samples": 3}
    },
    "my_custom_metric": 0.7
  },
  "customMetrics": {
    "my_custom_metric": {
      "codeConfig": {"name": "./metrics.js#score"},
      "metricInfo": {
        "metricName": "my_custom_metric",
        "description": "My custom metric.",
        "metricValueInfo": {"interval": {"minValue": -10.0, "maxValue": 10.0}}
      }
    }
  },
  "userSimulatorConfig": {"type": "llm_backed", "model": "gemini-2.5-flash"},
  "liveModelConfig": {"timeoutSeconds": 600}
}
```

Then read it and turn its criteria into metrics:

```typescript
import {
  getEvalMetricsFromConfig,
  getEvaluationCriteriaOrDefault,
} from '@google/adk';

const config = await getEvaluationCriteriaOrDefault('./test_config.json');

const timeoutSeconds = config.liveModelConfig?.timeoutSeconds; // 600
const metrics = getEvalMetricsFromConfig(config);
const names = metrics.map((metric) => metric.metricName);
// ['tool_trajectory_avg_score', 'final_response_match_v2', 'my_custom_metric']
```

`parseEvalConfig` reads the same document from a value you already have:

```typescript
import {parseEvalConfig} from '@google/adk';

const config = parseEvalConfig(JSON.parse(contents));
```

## Custom metrics

A custom metric needs an entry in `criteria`, which gives it a threshold, and
an entry in `customMetrics`, which says where its scoring function lives. The
`codeConfig` is the same code reference the declarative agent loader reads:
`name` is a `<module specifier>#<export>` pair such as `'./metrics.js#score'`,
it cannot be empty, and no other key is allowed. `metricInfo` is optional, and
describes the metric to the eval framework.

Read the recorded function path back with `getConfigCustomFunctionPath`, which
returns `undefined` for a metric the config named no function for:

```typescript
import {
  getConfigCustomFunctionPath,
  getEvalMetricsFromConfig,
} from '@google/adk';

const metrics = getEvalMetricsFromConfig(config);
const path = getConfigCustomFunctionPath(metrics[0]);
```

## Reading the user simulator section

`userSimulatorConfig` is a union, so narrow it on `type` before you read the
fields of one member:

```typescript
import {parseEvalConfig} from '@google/adk';

const config = parseEvalConfig({
  criteria: {},
  userSimulatorConfig: {type: 'llm_audio', audio_model: 'my-tts'},
});

const simulator = config.userSimulatorConfig;
const audioModel =
  simulator?.type === 'llm_audio' ? simulator.audioModel : undefined;
// 'my-tts'
```

Both simulator configs share the settings of the model that writes the user's
messages: `model`, `modelConfiguration`, `maxAllowedInvocations`,
`customInstructions` and `includeFunctionCalls`. `llm_audio` adds `audioModel`,
`audioModelConfiguration` and `includeTextWithAudio`.

Parsing applies the same defaults adk-python applies, so a section that names
only its `type` comes back with the model, the model configuration, the
invocation limit and the rest already filled in. A section of
`{"type": "llm_backed"}` gets a `model` of `'gemini-2.5-flash'`, a
`maxAllowedInvocations` of 20, and an `includeFunctionCalls` of false. A key the
config shape does not name is kept rather than dropped, which is how a simulator
reads a setting this package does not model. This is the one place an
unrecognized key is not an error; `codeConfig` and `metricInfo` both reject one.

Validate a section on its own when you do not have a whole document, which is
useful in a test:

```typescript
import {parseLlmBackedUserSimulatorConfig} from '@google/adk';

const simulator = parseLlmBackedUserSimulatorConfig({model: 'my-model'});
```

The section gets its own `type` when the payload names none, and a payload that
names another simulator's `type` is rejected.

## Building a config in code

An eval config does not have to come from a file. `getEvalMetricsFromConfig`
takes a config you built yourself, and validates each criterion as it reads it:

```typescript
import {getEvalMetricsFromConfig, type EvalConfig} from '@google/adk';

const config: EvalConfig = {
  criteria: {tool_trajectory_avg_score: 1.0},
  customMetrics: {
    my_custom_metric: {codeConfig: {name: './metrics.js#score'}},
  },
  userSimulatorConfig: {type: 'llm_backed', model: 'gemini-2.5-flash'},
};

const metrics = getEvalMetricsFromConfig(config);
```

## Failure modes

`parseEvalConfig` throws an `InputValidationError` when it cannot make sense of
the document. The error names the accepted values when a section names a `type`
no simulator answers to:

```
An eval config names a user simulator of type "typo_type_name". The supported
types are 'llm_backed' and 'llm_audio'.
```

An `InputValidationError` a schema raised carries the underlying `ZodError` as
its `cause`, so a caller that wants the structured issues can read them.
