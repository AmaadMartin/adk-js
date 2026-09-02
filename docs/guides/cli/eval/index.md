# adk eval

`adk eval` scores an agent against recorded eval sets from the command line and
prints how many cases passed. Reach for it when you want the verdict from a
shell or a CI job rather than from inside a test file.

## Introduction

`AgentEvaluator` scores an agent from your own test suite. It suits a
regression test, because the test framework decides what runs and reports the
failure. It does not suit a release script: that script has an agent file and a
directory of eval sets, and wants one command and a summary.

`adk eval` is that command. It resolves the app name and the agents directory
from the agent file, reads the eval sets you name, runs each of them, writes the
results to the eval history, and prints the pass and fail counts. The output
lines match adk-python's, so a script that greps them works against either SDK.

The command reads eval sets in two ways, and the first argument decides which.
A path to a `.evalset.json` file loads that file into memory. An id reads
`<agentsDir>/<appName>/<id>.evalset.json` through `LocalEvalSetsManager`, or the
matching blob when `--eval_storage_uri` names a bucket. Mixing paths and ids in
one invocation is not supported.

Scoring itself needs an eval service, which `@google/adk` does not ship yet. The
command asks `getEvalRuntime()` for one and stops with the missing-runtime
message when nothing has installed one, so `adk eval` reports that message
today. Everything around the service — reading eval sets, selecting eval cases,
writing results, printing — works now.

## Get started

Put an eval set next to the agent it scores:

```
agents/
  my_agent/
    agent.ts
    my_evals.evalset.json
```

Run every eval case in the file:

```bash
adk eval agents/my_agent/agent.ts agents/my_agent/my_evals.evalset.json
```

Run three named eval cases from an eval set stored under the agents directory:

```bash
adk eval agents/my_agent/agent.ts my_eval_set:case1,case2,case3
```

The summary names each eval set and its counts:

```
*********************************************************************
Eval Run Summary
my_eval_set:
  Tests passed: 2
  Tests failed: 1
```

## Where the run reads and writes

| Data                    | Path                                                                  |
| ----------------------- | --------------------------------------------------------------------- |
| Eval set, by id         | `<agentsDir>/<appName>/<evalSetId>.evalset.json`                      |
| Eval run result         | `<agentsDir>/<appName>/.adk/eval_history/<name>.evalset_result.json`  |
| Eval set in a bucket    | `gs://<bucket>/<appName>/evals/eval_sets/<evalSetId>.evalset.json`    |
| Eval result in a bucket | `gs://<bucket>/<appName>/evals/eval_history/<id>.evalset_result.json` |

The agent file decides `appName` and `agentsDir`. `agents/my_agent/agent.ts`
gives app `my_agent` under `agents`, and so does `agents/my_agent.ts`.

## Options

- `--config_file_path <path>` reads the eval config from that file. Without it,
  a run over a single eval set _file_ reads the `test_config.json` next to that
  file, and any other run uses the default criteria.
- `--print_detailed_results` prints each eval case after the summary: its
  overall status, each metric's score against its threshold, and a table of the
  invocations behind them.
- `--eval_storage_uri gs://<bucket>` reads the eval sets and writes the results
  in Cloud Storage instead of on disk. It needs the optional
  `@google-cloud/storage` peer dependency; any other scheme is rejected.
- `--log_level <level>` sets the log level, as on every other command.

## Failure modes

A missing argument prints the command's whole help, then one error line, and
exits 2:

```
$ adk eval
... full help ...
Error: Missing required argument: AGENT
```

An eval set file that is not there stops the run with
`` `<path>` should be a valid eval set file. `` An eval set file written in
ADK's original `{query, reference, expected_tool_use}` format is converted on
read, so old test data still runs.

A run whose eval cases fail still exits 0. The counts are the result; the exit
code reports whether the command itself worked.
