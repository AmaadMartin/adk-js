# AgentEvaluator

`AgentEvaluator` runs an agent over recorded eval data and fails the run when a
metric scores below its threshold. Reach for it when you want a "does my agent
still behave" test inside your own test suite.

## Introduction

The other evaluators score data you already have. `ResponseEvaluator` and
`TrajectoryEvaluator` each take a list of actual invocations and a list of
expected ones, and return a number. Something still has to run the agent,
collect those invocations, apply every metric, and turn the numbers into a
verdict. `AgentEvaluator` is that something.

It reads eval data from disk, seeds an in-memory eval set, runs the agent
`numRuns` times, averages each metric across all runs and invocations, and
throws `EvalFailureError` listing every metric that fell short. Averaging over
several runs is the point of `numRuns`: a model is not deterministic, so one
run is a weak signal.

`AgentEvaluator` does not run the agent itself. It builds an eval service
through an installed `EvalRuntime`, and that service owns inference, metric
scoring and result persistence. No runtime ships with `@google/adk` yet, so
every call fails with the missing-runtime message until you install one. That
is the one thing to know before you start.

## Get started

Install a runtime, then score an eval set. The runtime below is a stand-in that
returns fixed scores; a real one runs the agent.

```ts
import {
  AgentEvaluator,
  BaseEvalService,
  EvalCaseResult,
  EvalStatus,
  EvaluateRequest,
  InferenceRequest,
  InferenceResult,
  InferenceStatus,
  LlmAgent,
  setEvalRuntime,
} from '@google/adk';

class FixedScoreEvalService implements BaseEvalService {
  async *performInference(
    request: InferenceRequest,
  ): AsyncGenerator<InferenceResult> {
    yield {
      appName: request.appName,
      evalSetId: request.evalSetId,
      evalCaseId: 'greeting',
      status: InferenceStatus.SUCCESS,
    };
  }

  async *evaluate(_request: EvaluateRequest): AsyncGenerator<EvalCaseResult> {
    yield {
      evalSetId: 'greetings',
      evalId: 'greeting',
      finalEvalStatus: EvalStatus.PASSED,
      evalMetricResultPerInvocation: [
        {
          actualInvocation: {
            userContent: {role: 'user', parts: [{text: 'hi'}]},
            finalResponse: {role: 'model', parts: [{text: 'hello'}]},
          },
          evalMetricResults: [
            {
              metricName: 'response_match_score',
              criterion: {threshold: 0.8},
              score: 0.9,
              evalStatus: EvalStatus.PASSED,
            },
          ],
        },
      ],
    };
  }
}

setEvalRuntime({
  createEvalService: (): BaseEvalService => new FixedScoreEvalService(),
});

await AgentEvaluator.evaluateEvalSet({
  agentModule: {rootAgent: new LlmAgent({name: 'greeter'})},
  evalSet: {
    evalSetId: 'greetings',
    creationTimestamp: 0,
    evalCases: [
      {
        evalId: 'greeting',
        creationTimestamp: 0,
        conversation: [{userContent: {role: 'user', parts: [{text: 'hi'}]}}],
      },
    ],
  },
  evalConfig: {criteria: {'response_match_score': 0.8}},
  numRuns: 1,
});
```

Inside a test, `evaluate` is usually the call you want. It reads the eval data
from disk for you.

```ts
import {AgentEvaluator} from '@google/adk';
import * as agentModule from './weather_agent/agent.js';

it('scores the weather agent', async () => {
  await AgentEvaluator.evaluate({
    agentModule,
    evalDatasetFilePathOrDir: './weather_agent/evalset',
    numRuns: 2,
  });
});
```

## Naming the agent module

`agentModule` takes an imported module or a module specifier. Pass the imported
module. A relative specifier is resolved against the library file rather than
against your test, so it will not find your agent.

The module must expose the agent in one of these ways.

- A `rootAgent` binding, on the module or on a nested `agent` namespace.
- A `getAgentAsync()` function returning `[agent, cleanupMetadata]`.

An `app` export is surfaced alongside the agent when it is an `App`, so the
app's plugins and resumability config take part in the run. Set `agentName` to
score a sub-agent; the app is still surfaced.

## Eval data on disk

`evaluate` accepts one file, a directory, or an explicit list of files. A
directory is searched recursively for `*.test.json` files, which are then
processed one at a time in sorted order. A list is taken as the files
themselves, in the order given, and every entry must already exist.

```ts
await AgentEvaluator.evaluate({
  agentModule,
  evalDatasetFilePathOrDir: [
    './weather_agent/evalset/simple.test.json',
    './weather_agent/evalset/multi_turn.test.json',
  ],
  numRuns: 2,
});
```

Each file holds either an eval set in the current schema, or eval data in ADK's
original `[{query, reference, expected_tool_use}]` format. Data in the original
format is converted on the fly and logs a warning.
`AgentEvaluator.migrateEvalDataToNewSchema` rewrites such a file as an eval set,
which removes the warning.

Thresholds come from a `test_config.json` in the same folder as the test file.
A config in a parent folder is not consulted. Without one, the criteria are
`tool_trajectory_avg_score` at 1.0 and `response_match_score` at 0.8.

```json
{
  "criteria": {
    "tool_trajectory_avg_score": 1.0,
    "response_match_score": 0.7
  }
}
```

`initialSessionFile` supplies the session state every case starts from. It
applies only to data in the original format; an eval set in the current schema
carries its own `session_input`, and combining the two is an error.

## Reading the result

A passing run resolves and returns nothing. A failing run throws
`EvalFailureError` whose message lists one line per failing metric, naming the
threshold and the mean score. A run whose inference crashed produces no metric
results at all, and is reported separately by eval case id.

A metric that produced no score at all gets a different line, saying it *was
not evaluated*. This is what an unreachable judge model looks like: the
threshold was never checked, so the agent did not regress and the logs hold the
reason the metric could not run. The run still fails.

With `printDetailedResults` left at its default, each metric also logs a
summary line and a table of its invocations through `logger.info`. Set it to
`false` to silence that; the thrown message then tells you how to turn it back
on.

Set `outputFile` to also write every metric result to a CSV file, passing and
failing alike. Rows are appended, so several eval sets accumulate in one file
with a single header row. Parent directories are created.

Set `evalSetResultsManager` together with `appName` to persist the whole result
of the run. The eval service saves the results before `AgentEvaluator` throws,
so a failing run is still recorded.

## Custom metrics

An eval config can declare a metric scored by a function you wrote. Name it as
`<module specifier>#<export name>`; a bare specifier resolves to the module's
default export. adk-python splits a dotted Python path on its last `.`, which a
JavaScript specifier cannot support, so this SDK marks the export explicitly.

```json
{
  "criteria": {"brevity": 0.5},
  "custom_metrics": {
    "brevity": {"code_config": {"name": "./metrics.js#scoreBrevity"}}
  }
}
```

The function receives the metric, the actual invocations, the expected ones and
the conversation scenario, and returns an `EvaluationResult` or a promise of
one. The metric it receives carries no threshold: the function decides the
score, and `AgentEvaluator` decides whether that score passes.

`AgentEvaluator` registers these metrics into a fork of the default registry,
so a run's registrations last only for that run. Evaluators you registered on
the default registry yourself stay resolvable inside the fork. Importing the
specifier executes the module, at the same trust level as the agent module the
run already imports.

## Migrating off `criteria`

`evaluateEvalSet` still accepts a `criteria` option mapping a metric name to a
threshold. It is deprecated. When you pass it, `AgentEvaluator` logs a warning,
maps it onto an `EvalConfig` and ignores any `evalConfig` you passed alongside
it. Move to `evalConfig`, which also carries custom metrics and live-model
settings.

```ts
// Deprecated.
await AgentEvaluator.evaluateEvalSet({
  agentModule,
  evalSet,
  criteria: {'tool_trajectory_avg_score': 1.0},
});

// Preferred.
await AgentEvaluator.evaluateEvalSet({
  agentModule,
  evalSet,
  evalConfig: {criteria: {'tool_trajectory_avg_score': 1.0}},
});
```

A call that gives neither is rejected with `` `evalConfig` is required. ``
