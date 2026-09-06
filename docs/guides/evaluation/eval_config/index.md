# Eval config

The eval config module reads the `test_config.json` an evaluation runs from:
the metrics to score, the code behind a custom metric, the user simulator that
drives the conversation, and the timeout a live model gets. Reach for it when
you author that file, when you load one, or when you turn one into the metrics
an eval run scores.

## Introduction

An eval config is a JSON document a developer writes by hand and both ADK SDKs
read. That gives it two jobs at once. It has to be pleasant to write, so it
accepts a field under the name a Python author expects and under the name a
TypeScript author expects. It also has to be safe to load, so every section is
validated and a mistake is reported against the field that carries it.

The document has four sections. `criteria` maps a metric name to the criterion
that metric is judged against, either a bare threshold or a criterion object.
`customMetrics` maps a metric name to the code that scores it.
`userSimulatorConfig` configures the simulated user. `liveModelConfig` sets
the turn timeout for a Live API model. Every section except `criteria` is
optional.

Only `criteria` and `customMetrics` have keys the reader must not touch: their
keys are metric names such as `tool_trajectory_avg_score`, so they survive
verbatim. Everywhere else a field is read under its camelCase name and under
the snake_case name adk-python writes, and the camelCase name wins if a
document carries both. Metric names are therefore stable across SDKs while
field names are comfortable in each.

The user-simulator section is chosen by its `type`. `llm_backed` asks a model
for the next user message; `llm_audio` speaks that message with a
text-to-speech model. A section with no `type` reads as `llm_backed`, because
configs on disk predate the field. That promotion is logged at debug level and
you should write the `type` out.

## Get started

```ts
import {
  getEvaluationCriteriaOrDefault,
  getEvalMetricsFromConfig,
} from '@google/adk';

const config = await getEvaluationCriteriaOrDefault('./test_config.json');
const metrics = getEvalMetricsFromConfig(config);
```

`getEvaluationCriteriaOrDefault` returns the default config when you pass no
path, or when the file does not exist. The default scores
`tool_trajectory_avg_score` at 1.0 and `response_match_score` at 0.8. Any
other read failure, such as a directory in place of a file, is thrown.

A config file that uses every section:

```json
{
  "criteria": {
    "tool_trajectory_avg_score": 1.0,
    "final_response_match_v2": {
      "threshold": 0.5,
      "judgeModelOptions": {"judgeModel": "gemini-2.5-flash"}
    },
    "my_metric": 0.5
  },
  "customMetrics": {
    "my_metric": {
      "codeConfig": {"name": "./metrics.js#score"},
      "metricInfo": {
        "metricName": "my_metric",
        "description": "My custom metric.",
        "metricValueInfo": {"interval": {"minValue": -10, "maxValue": 10}}
      }
    }
  },
  "userSimulatorConfig": {"type": "llm_backed", "model": "gemini-2.5-flash"},
  "liveModelConfig": {"timeoutSeconds": 600}
}
```

`parseEvalConfig` reads the same document from a value you already have:

```ts
import {parseEvalConfig} from '@google/adk';

const config = parseEvalConfig(JSON.parse(contents));
```

## Custom metrics

A custom metric needs an entry in `criteria`, which gives it a threshold, and
an entry in `customMetrics`, which says where its scoring function lives. The
`codeConfig` is the same code reference the declarative agent loader reads:
`name` is a `<module specifier>#<export>` pair such as
`'./metrics.js#score'`, it cannot be empty, and no other key is allowed.

`metricInfo` is optional. It describes the metric to the eval framework: the
range it reports values in, and a sentence about what it measures.

`getEvalMetricsFromConfig` turns the criteria into the metrics an eval run
scores, and records the scoring function each metric was given. The path
travels with the metric object rather than in a registry keyed by name, so two
apps in one process can declare the same metric name and each still reaches
its own function. Read it back with `getConfigCustomFunctionPath`:

```ts
import {
  getConfigCustomFunctionPath,
  getEvalMetricsFromConfig,
} from '@google/adk';

const metrics = getEvalMetricsFromConfig(config);
const path = getConfigCustomFunctionPath(metrics[0]);
```

`getConfigCustomFunctionPath` returns `undefined` for a metric the config
named no function for.

## User simulator configs

Both simulator configs share the settings of the model that writes the user's
messages: `model`, `modelConfiguration`, `maxAllowedInvocations`,
`customInstructions` and `includeFunctionCalls`. `llm_audio` adds `audioModel`,
`audioModelConfiguration` and `includeTextWithAudio`.

Reading a config applies every default, so a consumer never has to. A section
of `{"type": "llm_backed"}` comes back with `model` set to
`'gemini-2.5-flash'`, `maxAllowedInvocations` set to 20, and
`includeFunctionCalls` set to false.

A key the config does not name is kept rather than dropped, so a simulator can
read a setting of its own out of a validated config. This is the one place an
unrecognized key is not an error; `codeConfig` and `metricInfo` both reject
one.

You can also validate a section on its own, which is useful in a test:

```ts
import {parseLlmBackedUserSimulatorConfig} from '@google/adk';

const simulator = parseLlmBackedUserSimulatorConfig({model: 'my-model'});
```

adk-python rejects a `customInstructions` template that does not carry the
`stop_signal`, `conversation_plan` and `conversation_history` Jinja
placeholders. This package does not check the template.

## Failure modes

`parseEvalConfig` throws when it cannot make sense of the document. It throws
a plain `Error` for a document that is not an object, a criterion that is
neither a number nor an object with a `threshold`, and a custom metric with no
`codeConfig` or no `codeConfig.name`. It throws an `InputValidationError` for
a `codeConfig` that a code reference rejects, an invalid `metricInfo`, a
`userSimulatorConfig` that is not an object, and a `userSimulatorConfig` whose
`type` no simulator answers to. The error names the accepted values:

```
The `userSimulatorConfig` of an eval config names an unknown `type`
"typo_type_name". Accepted values: llm_backed, llm_audio.
```

An `InputValidationError` raised by a schema carries the underlying `ZodError`
as its `cause`, so a caller that wants the structured issues can reach them.
