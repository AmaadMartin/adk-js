# Running evals from the CLI

`adk eval` replays recorded conversations through your agent and scores what it
does against what you recorded. Reach for it when you change a prompt, a tool,
or a model, and you want to know whether the agent still behaves the same way.

## Introduction

An agent is hard to test with ordinary unit tests. The model decides which tools
to call, so a change to an instruction can silently reroute the whole
conversation. `adk eval` gives you a regression signal for that: you record the
tool calls a good run makes, and the command tells you whether a later run still
makes them.

The command scores the **tool trajectory** — the sequence of tool names and
arguments — and, for a turn that records a reference response, how closely the
agent's own response matches it. A case passes when every metric you asked for
reaches its threshold.

Two neighbouring pieces do different jobs. `adk run` starts one interactive
conversation and prints it; it scores nothing. The integration harness under
`dev/src/integration/` replays canned model responses to test the SDK itself,
and is not meant for your agent.

Tool calls in your eval data can carry a recorded output. When they do, the tool
does not really run, so the eval is deterministic and touches no external
service.

## Get started

Write an agent file, the same kind `adk run` takes:

```ts
// agent.ts
import {FunctionTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

export const rootAgent = new LlmAgent({
  name: 'hello_world',
  model: 'gemini-flash-latest',
  instruction: 'Roll dice for the user.',
  tools: [
    new FunctionTool({
      name: 'roll_die',
      description: 'Rolls a die with the given number of sides.',
      parameters: z.object({sides: z.number()}),
      execute: ({sides}) => ({result: 1 + Math.floor(Math.random() * sides)}),
    }),
  ],
});
```

Record an eval set beside it. The file is a JSON array of cases:

```json
[
  {
    "name": "roll_a_six_sided_die",
    "data": [
      {
        "query": "Roll a die.",
        "expected_tool_use": [
          {
            "tool_name": "roll_die",
            "tool_input": {"sides": 6},
            "mock_tool_output": {"result": 4}
          }
        ]
      }
    ]
  }
]
```

Run it:

```bash
adk eval ./agent.ts ./roll_die.evalset.json
```

```
Using evaluation criteria: {"tool_trajectory_avg_score":1,"response_match_score":0.8}
Running Eval: ./roll_die.evalset.json:roll_a_six_sided_die
Metric: tool_trajectory_avg_score	Status: PASSED	Score: 1	Threshold: 1
Metric: response_match_score	Status: NOT_EVALUATED	Score: N/A	Threshold: 0.8
Result: ✅ Passed

*********************************************************************
Eval Run Summary
./roll_die.evalset.json:
  Tests passed: 1
  Tests failed: 0
```

## Selecting cases

Append a colon and a comma-separated list of case names to run only some of
them. A Windows drive letter is not treated as a separator.

```bash
adk eval ./agent.ts ./roll_die.evalset.json:case_1,case_3
```

You can pass several eval sets at once. Naming the same file twice adds its
selectors together.

Do not put a space after the comma. A selector must equal the case name
exactly, so `case_1, case_2` looks for a case named `" case_2"` and runs
nothing for it. adk-python behaves the same way.

## The eval-set file format

The keys are `snake_case`, because adk-python reads the same files.

| Key                 | Where    | Meaning                                                   |
| ------------------- | -------- | --------------------------------------------------------- |
| `name`              | case     | The case name a selector matches.                         |
| `data`              | case     | The recorded turns, in order.                             |
| `initial_session`   | case     | Optional `app_name`, `user_id` and `state` to start from. |
| `query`             | turn     | The user message to send.                                 |
| `expected_tool_use` | turn     | The tool calls the agent should make.                     |
| `tool_name`         | tool use | The tool's name.                                          |
| `tool_input`        | tool use | The arguments. Omitting it means no arguments.            |
| `mock_tool_output`  | tool use | The value to return instead of running the tool.          |

A case without `initial_session` runs under the app name `EvaluationGenerator`
and the user id `test_user_id`. Every case runs in a fresh session whose id
starts with `___eval___session___`.

## Agent files that export an App

If your agent file exports an `App` rather than a bare agent, `adk eval` runs
that `App`, so its plugins and its resumability config apply exactly as they do
under `adk run`. A plugin's `beforeToolCallback` can intercept a tool call, so
running without it would score a composition you never execute.

The app names the run. When an `App` is present its `name` is the app name, and
an `initial_session.app_name` in the eval data is ignored, because the runner
prefers the app's own name.

## Mocking a tool

`mock_tool_output` answers a tool call from the eval data. A call is answered
only when the tool name **and** the arguments both match the recorded entry;
otherwise the real tool runs. Each recorded turn is consumed once, so a repeated
identical call falls through to the real tool.

Mocking every tool makes a run fully deterministic. The model itself is still
called, so the agent needs credentials unless you point it at a local model.

## Criteria

Without `--config_file_path` the command uses these thresholds and logs that it
did:

```json
{"tool_trajectory_avg_score": 1.0, "response_match_score": 0.8}
```

To choose your own, write a config file and pass its path:

```json
{"criteria": {"tool_trajectory_avg_score": 1.0}}
```

```bash
adk eval ./agent.ts ./roll_die.evalset.json --config_file_path ./test_config.json
```

A metric passes when its score reaches the threshold. The case passes unless
some metric fails.

## Supported metrics

| Metric                      | Behaviour                                                                   |
| --------------------------- | --------------------------------------------------------------------------- |
| `tool_trajectory_avg_score` | Scored. The mean over turns of 1 for an exact tool-call match, 0 otherwise. |
| `response_match_score`      | Scored. The mean ROUGE-1 F-measure against each turn's `reference`.         |
| `response_evaluation_score` | Reported as `NOT_EVALUATED`.                                                |

`response_evaluation_score` needs a model-based judge, which adk-js does not
have yet. The command warns once per run and carries on.

## Scoring the response

Add a `reference` to a turn and `response_match_score` compares the agent's
final response with it. The score is the ROUGE-1 F-measure: the two texts are
split into lowercase words, and the score rises with the words they share.
Identical text scores 1 and text sharing no word scores 0.

```json
{
  "query": "Roll a die.",
  "expected_tool_use": [
    {"tool_name": "roll_die", "tool_input": {"sides": 6}, "mock_tool_output": 4}
  ],
  "reference": "You rolled a 4."
}
```

A turn without a `reference` records no expectation for the agent's prose, so
it is not scored. When no turn in a case records one, the metric reports
`NOT_EVALUATED` for that case. This is why the default criteria still give a
verdict on eval data that only records tool calls.

adk-python computes this score through Vertex AI's evaluation service. adk-js
computes it locally, because that service has no JavaScript client. The metric
key, the value range and the mean over turns are the same, so the same
threshold means the same thing. The two scores can differ in the last decimal.

## Resetting agent state between cases

Export a `resetData` function from your agent file and the command calls it once
before each case's turns. Use it to clear state your tools own.

```ts
// agent.ts
let rolls: number[] = [];

export function resetData() {
  rolls = [];
}
```

adk-python calls this export `reset_data`. adk-js agent files are camelCase
(`rootAgent`, `app`), so the hook is `resetData` here.

## Failure modes

| Condition                                                                         | What happens                                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| One case throws                                                                   | The command prints `Error: <message>` and runs the next case. |
| A selector names no case in the file                                              | The file contributes no results. This is not an error.        |
| The eval-set file is empty or is not an array                                     | The command throws and names the file.                        |
| The criteria file has no `criteria` object, or a threshold is not a finite number | The command throws and names the file.                        |
| No `--config_file_path`                                                           | Not an error. The default criteria apply.                     |

The process exits `0` whether cases pass or fail, matching adk-python. Read the
summary block, or call `runEvals` yourself, to gate a build on the result.

## Seeing the detail

`--print_detailed_results` prints a per-turn table of the query, the expected
tool calls, the actual tool calls and the score.

```bash
adk eval ./agent.ts ./roll_die.evalset.json --print_detailed_results
```
