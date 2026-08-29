# Response evaluator

`evaluateResponses` scores an agent's final natural-language answers against
golden answers you recorded earlier. Reach for it when you have a set of
questions with known good answers, and you want one number that says how far
the agent has drifted from them.

## Introduction

An agent test suite has two things to check: the tools the agent called, and
the prose it produced. The tool calls are exact, so you can compare them
directly. The prose is not, because a model rewords the same answer on every
run. `evaluateResponses` gives you a similarity score instead of an equality
check.

The score is the ROUGE-1 f-measure. It reduces both texts to lowercase words,
counts the words they have in common, and returns the balance of precision and
recall. Word order does not change the score. Padding the answer lowers
precision, and leaving something out lowers recall.

Read the score as similarity, not as correctness. "The light is on" and "the
light is off" share almost every word, so they score high while meaning the
opposite. A high score tells you the agent still answers in the shape you
recorded. It does not tell you the answer is true.

adk-python scores the same metric under the same name, `response_match_score`,
and uses `0.8` as its default threshold. The two SDKs read the same eval data,
so the turn fields stay snake_case here: `query`, `response`, `reference`,
`expected_tool_use` and `actual_tool_use`.

## Get started

Pass one list per recorded session, each holding that session's turns.

```ts
import {
  evaluateResponses,
  ResponseCriterion,
  ROUGE_1_METRIC,
} from '@google/adk';

const summary = evaluateResponses(
  [
    [
      {
        query: 'roll a die for me',
        response: 'I rolled a 16 sided die and got 13.',
        reference: 'I rolled a 16 sided die and got 13.',
      },
    ],
  ],
  [ResponseCriterion.RESPONSE_MATCH_SCORE],
);

summary.rowCount; // 1
summary.summaryMetrics[ROUGE_1_METRIC]; // 1
summary.perTurnScores[ROUGE_1_METRIC]; // [1]
```

`summaryMetrics` holds the mean score of each metric. `perTurnScores` holds
every turn's score, in the order the turns appear once the sessions are
flattened. To assert on the result in a test suite, compare the mean against
the threshold adk-python uses:

```ts
expect(summary.summaryMetrics[ROUGE_1_METRIC]).toBeGreaterThanOrEqual(0.8);
```

## Which turns are scored

The criterion applies to the whole run or to none of it. `evaluateResponses`
looks at the first turn of the first session, and it scores
`response_match_score` only when that turn carries a `reference` key.
adk-python probes the same single turn to pick its metrics, so both SDKs read
an eval file the same way. When the criterion does not apply, the function
returns `summaryMetrics: {}` rather than raising an error.

Once the criterion applies, every turn is scored. A turn that carries no
`reference`, or that produced no `response`, scores 0 and still counts towards
the mean.

## Failure modes

| Input                                      | Result                                                             |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `null` or `[]` as the dataset              | `InputValidationError`, message `The evaluation dataset is empty.` |
| `response_evaluation_score` as a criterion | `InputValidationError`                                             |
| A criterion name neither SDK knows         | Ignored                                                            |

`response_evaluation_score` is the other criterion adk-python supports. It asks
a model to judge how coherent the response is, through the Vertex AI evaluation
service. Neither `@google/genai` nor `@google-cloud/vertexai` exposes a client
for that service, so `evaluateResponses` rejects the criterion. It does not
skip it silently, because a caller who asked for a judgement and got a
clean-looking summary back would read a pass that nobody measured.

## Tokenization

The tokenizer keeps Unicode letters and digits and drops everything else, so
accented and non-Latin text produces tokens instead of scoring 0. It applies no
stemming, so "run" and "running" are two words. A script written without spaces
(Chinese, Japanese, Thai) gives one token per run of characters rather than one
per word.
