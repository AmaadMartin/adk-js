# AgentEvaluator

`AgentEvaluator` runs a recorded eval dataset against an agent and throws when a metric falls below its threshold, so a change that makes the agent answer worse fails a test the way a broken unit test does. It is not exported from `@google/adk` yet: scoring needs the local eval service, which this package does not carry. What ships today is the eval data model it runs on, and this guide covers that.

## Introduction

An agent is hard to test with plain assertions. The model paraphrases, so the exact reply changes between runs, and a single run is noisy enough that one bad sample says little. An eval dataset answers both problems: it records the prompts and the reference answers once, and each metric is scored per invocation, averaged over several runs, and compared with a threshold you set.

The pieces that make up a dataset:

- `EvalSet` is the dataset. It holds `EvalCase`s, each a conversation of `Invocation`s with the reference answer and the tool calls that were expected.
- `EvalConfig` is the criteria: metric names mapped to thresholds. It is read from a `test_config.json` beside the eval data, so two folders can hold the same agent to different standards.
- `EvalSetsManager` stores the eval sets of an app, and `InMemoryEvalSetsManager` is the implementation a test uses.
- `EvalSetResultsManager` persists the results of a run.

`PrebuiltMetrics` names the metrics ADK ships, and its values are the keys you write in a config file. The metric implementations are what the local eval service brings; the names, the thresholds and the data shapes are here.

## Get started

Put the eval data and its criteria in one folder.

`tests/dice/test_config.json`:

```json
{
  "criteria": {
    "tool_trajectory_avg_score": 1.0,
    "response_match_score": 0.8
  }
}
```

`tests/dice/roll.test.json`, in ADK's original eval data format:

```json
[
  {
    "query": "Roll a 6 sided dice",
    "reference": "I rolled a 4.",
    "expected_tool_use": [{"tool_name": "roll_die", "tool_input": {"sides": 6}}]
  }
]
```

Read the criteria back, and see the metrics a run would score:

```ts
import {
  getEvalMetricsFromConfig,
  getEvaluationCriteriaOrDefault,
} from '@google/adk';

const config = await getEvaluationCriteriaOrDefault(
  './tests/dice/test_config.json',
);
const metrics = getEvalMetricsFromConfig(config);
// metrics[0] is {metricName: 'tool_trajectory_avg_score',
//                criterion: {threshold: 1}, customFunctionPath: undefined}
```

A folder with no `test_config.json` gets `DEFAULT_EVAL_CONFIG`: `tool_trajectory_avg_score` at `1.0` and `response_match_score` at `0.8`.

## Field names on disk

Eval files are written by adk-python as well as by this package, so their field names are snake_case and stay that way: `eval_set_id`, `eval_cases`, `eval_id`, `user_content`, `final_response`, `intermediate_data`, `tool_uses`, `session_input`. The TypeScript interfaces use camelCase, like the rest of adk-js, and the two are converted at the file boundary. Tool call arguments and session state are copied through untouched, because their keys are your data rather than model fields.

## Converting older eval data

`convertLegacyEvalSet` turns eval data in ADK's original format into an `EvalSet`:

```ts
import {convertLegacyEvalSet} from '@google/adk';
import {readFile} from 'node:fs/promises';

const data = JSON.parse(await readFile('./tests/dice/roll.test.json', 'utf-8'));
const evalSet = convertLegacyEvalSet('dice', [
  {name: 'roll_die', data, initialSession: {app_name: 'dice', user_id: 'user'}},
]);
```

Each record's `query` becomes the user content, `reference` becomes the expected final response, and `expected_tool_use` becomes the expected tool calls. `initialSession` is keyed in snake_case because it is read from a file adk-python wrote, and it becomes the eval case's `sessionInput`.
