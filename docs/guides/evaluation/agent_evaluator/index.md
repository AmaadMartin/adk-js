# AgentEvaluator

`AgentEvaluator` runs a recorded eval dataset against an agent and throws when a metric falls below its threshold. Call it from a normal test, so a change that makes the agent answer worse fails the build the way a broken unit test does.

## Introduction

An agent is hard to test with plain assertions. The model paraphrases, so the exact reply changes between runs, and a single run is noisy enough that one bad sample says little. An eval dataset answers both problems: it records the prompts and the reference answers once, and each metric is scored per invocation, averaged over several runs, and compared with a threshold you set.

`AgentEvaluator` is the entry point for that. It resolves the dataset, reads the criteria that apply to it, runs the agent, averages the scores and reports the result. It does not score anything itself: the metric evaluators live in the local eval service, which `AgentEvaluator` loads at the point of use. A build without that service can still read, validate and migrate eval data, but a call to `evaluate` fails with a message saying the eval runtime is missing.

The pieces around it:

- `EvalSet` is the dataset. It holds `EvalCase`s, each a conversation of `Invocation`s with the reference answer and the tool calls that were expected.
- `EvalConfig` is the criteria: metric names mapped to thresholds. It is read from a `test_config.json` beside the eval data, so two folders can hold the same agent to different standards.
- `EvalSetResultsManager` persists the results of a run. Pass one to keep the report after the test process exits.

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

Then call the evaluator from a test:

```ts
import {AgentEvaluator} from '@google/adk';
import {it} from 'vitest';

it('rolls dice correctly', async () => {
  await AgentEvaluator.evaluate({
    agentModule: './samples/dice/agent.js',
    evalDatasetFilePathOrDir: './tests/dice/',
    numRuns: 2,
  });
});
```

`evaluate` walks the directory for `*.test.json` files, reads the `test_config.json` in each file's own folder, runs the agent `numRuns` times per case, averages each metric and throws when one is below its threshold.

## Finding the agent

`agentModule` is a module specifier, given either as a package name or as a path. The module is imported, which runs its top-level code, so treat the specifier as being as trusted as the code that supplies it. A Node built-in is refused. The evaluator then looks, in order, for:

1. an `app` or `rootApp` export that is an `App`, and takes its root agent;
2. a `rootAgent` export;
3. a `getAgentAsync` factory, which it awaits.

When the module exports an `App`, that app is passed to the eval run, so its plugins and its resumability config apply. Set `agentName` to evaluate a sub-agent instead; the app is still applied.

## Reading the report

By default each metric prints a summary line and a table of its per-invocation results through the ADK logger at `info` level. Set `printDetailedResults: false` to turn that off; the thrown failure then tells you how to turn it back on.

Set `outputFile` to also write the results as CSV:

```ts
await AgentEvaluator.evaluate({
  agentModule: './samples/dice/agent.js',
  evalDatasetFilePathOrDir: './tests/dice/',
  outputFile: './eval-results/dice.csv',
});
```

Rows are appended and the header is written once, so a dataset spread over several files still produces one table. The columns are `eval_set_id`, `eval_id`, `metric_name`, `threshold`, `score`, `eval_status`, `prompt`, `expected_response`, `actual_response`, `expected_tool_calls` and `actual_tool_calls`.

## Migrating older eval data

Data in ADK's original format is converted on every run, and the evaluator logs a warning saying so. Convert it once instead:

```ts
import {AgentEvaluator} from '@google/adk';

await AgentEvaluator.migrateEvalDataToNewSchema({
  oldEvalDataFile: './tests/dice/roll.test.json',
  newEvalDataFile: './tests/dice/roll.migrated.test.json',
  initialSessionFile: './tests/dice/initial.session.json',
});
```

Give the migrated file a `.test.json` name and put the original aside, because `evaluate` only collects `*.test.json`. It reads either format from that name, so the migrated file is picked up in place of the original.

The written file holds an `EvalSet` with snake_case field names, the same form adk-python reads and writes. An explicit initial session belongs only to the original format: once the data is an eval set, the session lives in the eval case's `session_input`, and passing `initialSessionFile` alongside an eval set file is an error.
