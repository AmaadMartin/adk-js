# Running evals from the CLI

`adk eval` replays recorded conversations through your agent and scores what it
did against what you recorded: the tool calls it made, and the answer it gave.
Reach for it when you change a prompt, a tool, or a model, and you want to know
whether the agent still behaves the same way.

Run `adk eval --help` for the flags. This page covers what the flags cannot: the
file format, what each metric means, and when the command fails a build.

## Introduction

An agent is hard to test with ordinary unit tests. The model decides which tools
to call, so a change to an instruction can silently reroute the whole
conversation. `adk eval` gives you a regression signal for that.

The command scores two things. The **tool trajectory** is the sequence of tool
names and arguments; a turn passes it when the recorded calls match the expected
ones exactly, in order. The **response match** compares the agent's final answer
with the answer you recorded as `reference`. Neither metric asks a model to
judge the agent, so a run costs nothing beyond the agent's own calls.

`adk run` is the neighbouring command: it starts one interactive conversation
and prints it, and it scores nothing.

## Get started

Record an eval set beside your agent file. The file is a JSON array of cases:

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
            "mock_tool_output": 4
          }
        ],
        "reference": "You rolled a 4."
      }
    ]
  }
]
```

Run it against the agent file `adk run` takes:

```bash
adk eval ./agent.ts ./roll_die.evalset.json
```

```
Using evaluation criteria: {"tool_trajectory_avg_score":1,"response_match_score":0.8}
Running Eval: ./roll_die.evalset.json:roll_a_six_sided_die
Metric: tool_trajectory_avg_score	Status: PASSED	Score: 1	Threshold: 1
Metric: response_match_score	Status: PASSED	Score: 1	Threshold: 0.8
Result: ✅ Passed

*********************************************************************
Eval Run Summary
./roll_die.evalset.json:
  Tests passed: 1
  Tests failed: 0
```

Append `:case_1,case_3` to an eval-set path to run only those cases. A Windows
drive letter is not treated as a separator. Do not put a space after the comma:
a selector must equal the case name exactly, so `case_1, case_2` looks for a
case named `" case_2"`. adk-python behaves the same way.

## The eval-set file format

The keys are `snake_case`, because adk-python reads the same files.

| Key                 | Where    | Meaning                                                   |
| ------------------- | -------- | --------------------------------------------------------- |
| `name`              | case     | The case name a selector matches.                         |
| `data`              | case     | The recorded turns, in order.                             |
| `initial_session`   | case     | Optional `app_name`, `user_id` and `state` to start from. |
| `query`             | turn     | The user message to send.                                 |
| `expected_tool_use` | turn     | The tool calls the agent should make.                     |
| `reference`         | turn     | The answer to score the agent's final answer against.     |
| `tool_name`         | tool use | The tool's name.                                          |
| `tool_input`        | tool use | The arguments. Omitting it means no arguments.            |
| `mock_tool_output`  | tool use | The value to return instead of running the tool.          |

A case without `initial_session` runs under the app name `EvaluationGenerator`
and the user id `test_user_id`. Every case runs in a fresh session whose id
starts with `___eval___session___`.

`mock_tool_output` answers a tool call from the eval data, so the real tool does
not run. A call is answered only when the tool name **and** the arguments both
match, and each recorded turn is consumed once, so a repeated identical call
falls through to the real tool. Mocking every tool makes the run deterministic,
but the model itself is still called.

If your agent file exports an `App` rather than a bare agent, the command runs
that `App`, so its plugins and its resumability config apply as they do under
`adk run`. The app then names the run, and `initial_session.app_name` is
ignored.

Export a `resetData` function from the agent file and the command calls it once
before each case's turns, awaiting the result. adk-python calls this export
`reset_data`; adk-js agent files are camelCase, so the hook is `resetData` here.

## Metrics and criteria

| Metric                      | Behaviour                                                           |
| --------------------------- | ------------------------------------------------------------------- |
| `tool_trajectory_avg_score` | The mean over turns of 1 for an exact tool-call match, 0 otherwise. |
| `response_match_score`      | The mean ROUGE-1 F-measure against each turn's `reference`.         |
| `response_evaluation_score` | Reported as `NOT_EVALUATED`.                                        |

`response_evaluation_score` asks a model to judge how coherent the answer is,
and adk-js has no judge for it. Any metric name the command cannot score takes
the same path: one warning per run, and `NOT_EVALUATED` for every case.

`response_match_score` lowercases both texts and splits them into words on every
non-alphanumeric character, so case, punctuation and word order do not matter. A
word the answer repeats counts only as often as the reference repeats it. A turn
with no `reference` is not scored, and a case where no turn has one reports
`NOT_EVALUATED`. adk-python scores this with Vertex AI's hosted `rouge_1`
metric; adk-js computes the same measure locally, so the command needs no Google
Cloud project and makes no extra network call.

Without `--config_file_path` the command uses
`{"tool_trajectory_avg_score": 1.0, "response_match_score": 0.8}` and logs that
it did. To choose your own, write
`{"criteria": {"tool_trajectory_avg_score": 1.0}}` and pass its path.

## Passing, failing and the exit code

A metric passes when its score reaches its threshold. A case passes when at
least one metric passed and none failed.

The command exits `1` when any case failed and `0` otherwise, so a build can
gate on it directly. "Failed" is exactly what the summary counts under "Tests
failed": a case that failed a metric, a case that threw, and a case whose
metrics all abstained. That last one matters. Criteria naming only metrics the
command cannot score fail every case, rather than reporting a silent success.

adk-python v0.1.0 always exits `0`. adk-js diverges here, because an eval
command that cannot fail a build cannot protect one.

| Condition                                                      | What happens                                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| One case throws                                                | The command prints `Error: <message>`, counts the case as failed, and runs the next case. |
| A selector names no case in the file                           | The file contributes no results. This is not an error.                                    |
| The eval-set file is empty or is not an array                  | The command throws and names the file.                                                    |
| The criteria file is malformed, or a threshold is not a number | The command throws and names the file.                                                    |
