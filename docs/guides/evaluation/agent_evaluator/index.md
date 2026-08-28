# AgentEvaluator

`AgentEvaluator` runs an agent against recorded conversations and fails your test when the agent drifts. Reach for it when you want a regression test that pins the tools an agent calls and the answer it gives, rather than a unit test of one function.

## Introduction

An agent's behaviour is not pinned by its code. A prompt edit, a new tool, or a model swap can change which tools the agent calls and what it finally says, and nothing in the type system notices. `AgentEvaluator` closes that gap: you record a conversation once, and every later run is scored against it.

You give it a directory of `*.test.json` files. For each recorded conversation it replays the user turns through a `Runner`, projects the resulting events into invocations, and scores them with two metrics:

- `tool_trajectory_avg_score` compares the tool calls the agent made against the recorded ones.
- `response_match_score` compares the final answer against the recorded one, using ROUGE-1 overlap.

Each metric has a threshold, read from a `test_config.json` next to the eval file. Every case runs twice by default and the scores are averaged before the comparison, so one unlucky sample does not fail the build. When a metric ends up below its threshold, `evaluate` throws an `EvalFailureError` whose message names every failing metric and shows the per-invocation detail.

The eval file format is shared with adk-python. A file written by either SDK loads in the other, so a team running both can keep one set of eval data.

`AgentEvaluator` is the small, test-facing entry point. For running evals as a service — streaming results, persisting them, simulated users — use `LocalEvalService` instead.

## Get started

Record a conversation in `tests/fixtures/dice/roll.test.json`:

```json
[
  {
    "query": "Roll a 17 sided dice",
    "expected_tool_use": [
      {"tool_name": "roll_die", "tool_input": {"sides": 17}}
    ],
    "reference": "I rolled a 17 sided die and got 13.\n"
  }
]
```

Set the thresholds in `tests/fixtures/dice/test_config.json`:

```json
{
  "criteria": {
    "tool_trajectory_avg_score": 1.0,
    "response_match_score": 0.8
  }
}
```

Then point the evaluator at the directory:

```ts
import {AgentEvaluator} from '@google/adk';
import {describe, it} from 'vitest';

import {rootAgent} from './dice_agent.js';

describe('dice agent', () => {
  it('rolls the die the user asked for', async () => {
    await AgentEvaluator.evaluate({
      agent: rootAgent,
      evalDatasetFilePathOrDir: 'tests/fixtures/dice',
    });
  });
});
```

`evaluate` resolves when every metric passes and throws when one does not. It runs the agent for real, so the agent's model is called; keep eval runs out of any test job that must not reach a model.

## Eval file formats

Two on-disk shapes are accepted, and both may use the `.test.json` suffix.

The **legacy array format** above is one JSON array of turns, with `query`, `reference`, `expected_tool_use` and `expected_intermediate_agent_responses`. It is the shape most adk-python users have.

The **eval set format** is a JSON object with `eval_set_id` and `eval_cases`. It carries several cases per file, a per-case `session_input`, and the full `Content` of each turn. Field names may be spelled `snake_case` or `camelCase`; adk-js writes `snake_case` so adk-python can read it back.

`AgentEvaluator` tries the eval set format first and falls back to the legacy format, logging a warning that names the file.

To convert a legacy file once and stop seeing the warning:

```ts
import {AgentEvaluator} from '@google/adk';

AgentEvaluator.migrateEvalDataToNewSchema(
  'tests/fixtures/dice/roll.test.json',
  'tests/fixtures/dice/roll.evalset.json',
);
```

Keys you define yourself are never renamed in either direction. A tool argument named `sides_count`, a session state key named `user_name`, and the metric names inside `criteria` all survive verbatim.

## Options

```ts
await AgentEvaluator.evaluate({
  agent: rootAgent,
  evalDatasetFilePathOrDir: 'tests/fixtures/dice',
  // Times to run every case before averaging. Defaults to 2.
  numRuns: 4,
  // Evaluate a sub-agent instead of the root.
  agentName: 'dice_sub_agent',
  // Session values shared by every case in a legacy-format dataset.
  initialSessionFile: 'tests/fixtures/dice/initial_session.json',
  // Drop the per-invocation detail from the failure message.
  printDetailedResults: false,
});
```

`evalDatasetFilePathOrDir` takes one file, or a directory that is searched recursively for `*.test.json`. A directory runs every file it finds, each with the `test_config.json` from its own directory.

`initialSessionFile` holds one JSON object in the legacy spelling:

```json
{"app_name": "dice", "user_id": "user", "state": {"user_name": "Ada"}}
```

It applies to legacy-format files only. An eval set file carries its own `session_input` per case, so combining the two is an error.

## Metrics

The metric names in `criteria` are the names the registry knows. `AgentEvaluator` scores two of them:

| Metric                      | What it scores                             |
| --------------------------- | ------------------------------------------ |
| `tool_trajectory_avg_score` | The tool calls, against the recorded ones. |
| `response_match_score`      | The final answer, by ROUGE-1 overlap.      |

adk-python also allows `response_evaluation_score` and `safety_v1`. Both need the Vertex Gen AI Eval service, which adk-js does not ship, so `evaluate` rejects them with an `UnsupportedMetricError` naming the metric.

A criterion is either a bare threshold or an object. Use the object form to pick how the tool trajectory is matched:

```json
{
  "criteria": {
    "tool_trajectory_avg_score": {"threshold": 1.0, "match_type": 1}
  }
}
```

`match_type` is `0` for an exact match, `1` for the expected calls in order with extras allowed, and `2` for the expected calls in any order. The integers match adk-python, so a config written there loads here.

An eval set file may use any metric in the registry, not only these two. The two-metric restriction applies to legacy-format files, matching adk-python.

## Differences from adk-python

Two signatures differ deliberately.

adk-python takes an `agent_module` string and imports it, looking for a `root_agent`. TypeScript has no such convention, so `evaluate` takes a `BaseAgent` and the caller imports their own agent.

adk-python prints its failure table to stdout. adk-js puts the whole report in the thrown `EvalFailureError`, and also emits it through `logger.debug`.
