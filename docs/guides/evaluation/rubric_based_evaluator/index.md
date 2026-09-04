# RubricBasedEvaluator

`RubricBasedEvaluator` is the base class for an evaluation metric that grades an
agent against written rubrics. Extend it when the quality you measure breaks
down into separate yes/no questions — "did it cite a source", "did it call the
weather tool", "was it concise" — and you want a verdict for each of them
rather than one opaque number.

## Introduction

`LlmAsJudge` asks a model for one score per invocation. That is enough when the
metric measures one thing. It stops being enough as soon as you want to know
_which_ part of the answer failed, because a single 0.4 does not tell you.

A rubric metric asks the same judge model a list of questions instead. Each
question is a `Rubric`: an id and a text property such as "The response cites
its source." The judge answers one block per rubric, and the metric reports one
`RubricScore` per rubric alongside the overall score. A failing eval then points
at the rubric that failed.

The class handles the parts that are the same for every rubric metric. It reads
the judge's blocks back into per-rubric verdicts, binds each verdict to the
rubric it graded, settles the repeated samples of one invocation by majority
vote, and averages the invocations into the eval case's score. A subclass
supplies only the prompt.

Rubrics come from two places. The criterion carries the rubrics that apply to
every invocation, and an invocation can carry rubrics of its own. Call
`createEffectiveRubricsList` before grading to combine them.

## Get started

A metric extends the class and implements `formatAutoRaterPrompt`. The prompt
must ask the judge for the block format the parser reads:

```ts
import {
  EvalMetric,
  Invocation,
  RubricBasedEvaluator,
  getTextFromContent,
  parseRubricsBasedCriterion,
} from '@google/adk';

/** Grades an agent's final answer against the rubrics on its criterion. */
class FinalAnswerRubricMetric extends RubricBasedEvaluator {
  constructor(evalMetric: EvalMetric) {
    super({evalMetric, parseCriterion: parseRubricsBasedCriterion});
  }

  formatAutoRaterPrompt(actual: Invocation): string {
    const rubrics = this.getEffectiveRubricsList()
      .map(
        (rubric) =>
          `ID: ${rubric.rubricId}\n` +
          `Property: ${rubric.rubricContent.textProperty}`,
      )
      .join('\n\n');

    return [
      'Answer each property below with a Rationale and a Verdict.',
      'Repeat the ID and the Property, then write "Rationale: ..." and',
      '"Verdict: yes" or "Verdict: no".',
      `Question: ${getTextFromContent(actual.userContent)}`,
      `Answer: ${getTextFromContent(actual.finalResponse)}`,
      rubrics,
    ].join('\n\n');
  }
}
```

Write the rubrics onto the metric's criterion, then run it:

```ts
const metric: EvalMetric = {
  metricName: 'final_answer_rubrics',
  criterion: {
    threshold: 0.5,
    rubrics: [
      {
        rubricId: '1',
        rubricContent: {textProperty: 'The answer cites a source.'},
      },
      {rubricId: '2', rubricContent: {textProperty: 'The answer is concise.'}},
    ],
    judgeModelOptions: {numSamples: 3},
  },
};

const evaluator = new FinalAnswerRubricMetric(metric);
evaluator.createEffectiveRubricsList(actualInvocations[0].rubrics);
const result = await evaluator.evaluateInvocations(actualInvocations);
```

`result.overallRubricScores` holds one entry per rubric the judge graded, and
each `perInvocationResults` entry holds that invocation's own rubric scores.

## How a response is parsed

`DefaultAutoRaterResponseParser` reads four line prefixes: `ID:` and
`Property:` must start a line, while `Rationale:` and `Verdict:` may appear
anywhere. A verdict containing `yes` scores 1, one containing `no` scores 0,
and anything else leaves the rubric unscored but still reported.

The parser rejects a partial block. If the number of properties, rationales and
verdicts is not the same, it returns nothing at all. A block that is cut off
mid-answer would otherwise drop a failing rubric and raise the score.

None of this throws. Judge output is model output, so text the parser cannot
read is logged as a warning and scored as unevaluated.

## How a rubric is matched

Each parsed block is bound to a rubric by id first. When the judge echoed no id,
or an id no rubric holds, the metric falls back to matching the property text
against the rubric text.

That text comparison is forgiving, because judge models decorate the text they
echo back. Both sides are normalized first: Unicode is composed to NFKC, smart
quotes and dashes become their ASCII forms, runs of whitespace collapse to one
space, markdown decoration (`*`, `_`, backticks, `#`, `>`, `-`, bullets, quotes)
is stripped from both ends, and the result is lowercased. Accents survive, so a
French rubric still matches. A block that matches neither an id nor a text is
logged and dropped.

## Aggregation and summarization

`MajorityVotePerInvocationResultsAggregator` settles one invocation. For each
rubric it counts the samples that said yes against those that said no, and
keeps the first sample on the winning side — so the invocation reports a
rationale the judge actually wrote. A tie loses: the rubric only passes when
more samples say yes than say no. The invocation's score is the mean of the
surviving rubric scores.

`MeanInvocationResultsSummarizer` settles the eval case. Each rubric's overall
score is the mean of its observations across the invocations. The overall score
of the case is the mean over _every_ observation, not the mean of the per-rubric
means, so an invocation that graded more rubrics counts for more. An aggregated
rubric score carries a fixed rationale saying it is an aggregate, because a mean
has no reasoning behind it.

Both use the criterion's threshold. A score is `PASSED` when it is greater than
or equal to the threshold, and `NOT_EVALUATED` when nothing was scored at all —
a threshold of 0 does not turn an unscored run into a pass.

## Replacing a collaborator

The three steps above are injectable. Pass your own to change one without
touching the rest:

```ts
import {
  AutoRaterResponseParser,
  EvalMetric,
  RubricBasedEvaluator,
  RubricResponse,
  parseRubricsBasedCriterion,
} from '@google/adk';

/** Reads a judge that replies with JSON instead of Property blocks. */
class JsonResponseParser implements AutoRaterResponseParser {
  parse(autoRaterResponse: string): RubricResponse[] {
    return JSON.parse(autoRaterResponse) as RubricResponse[];
  }
}

class JsonRubricMetric extends RubricBasedEvaluator {
  constructor(evalMetric: EvalMetric) {
    super({
      evalMetric,
      parseCriterion: parseRubricsBasedCriterion,
      autoRaterResponseParser: new JsonResponseParser(),
    });
  }

  formatAutoRaterPrompt(): string {
    return 'Reply with a JSON array of {rubricId, rationale, score}.';
  }
}
```

`perInvocationResultsAggregator` and `invocationResultsSummarizer` replace the
other two steps the same way. Both are handed the criterion's threshold, so an
alternative implementation does not have to resolve it itself.

Set `rubricType` when the invocation carries rubrics for several metrics at
once. The metric then keeps only the invocation rubrics whose `type` matches,
and ignores the rest.
