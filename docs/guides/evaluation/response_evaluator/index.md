# ResponseEvaluator

`ResponseEvaluator` scores the final answer an agent gave. Reach for it when
you have a set of recorded answers, a set of golden answers, and you need one
number per answer plus a pass or fail verdict.

## Introduction

An agent test suite records what the agent replied. Deciding whether the reply
was good is the hard part. `ResponseEvaluator` offers two ways to decide.

- `response_match_score` compares the answer to a golden answer with the
  ROUGE-1 measure. It counts the unigrams the two texts share. The score runs
  from 0 to 1, and a score closer to 1 is better. It runs locally and needs no
  credentials.
- `response_evaluation_score` asks the Vertex AI Gen AI evaluation service how
  coherent the answer is. The score runs from 1 to 5, and a score closer to 5
  is better. This metric needs no golden answer text to compare against, but it
  does need the service.

Both metrics implement the `Evaluator` interface, so a harness can hold either
one behind the same call. `ResponseEvaluator` itself only picks the metric and
delegates: `response_match_score` goes to `RougeEvaluator`, and
`response_evaluation_score` goes to `SingleTurnVertexAiEvalFacade`. Use those
two classes directly when you already know which metric you want.

## Get started

Score one answer against a golden answer.

```ts
import {EvalStatus, Invocation, ResponseEvaluator} from '@google/adk';

const actual: Invocation[] = [
  {
    userContent: {parts: [{text: 'What is the capital of France?'}]},
    finalResponse: {parts: [{text: 'The capital of France is Paris.'}]},
  },
];
const expected: Invocation[] = [
  {
    userContent: {parts: [{text: 'What is the capital of France?'}]},
    finalResponse: {parts: [{text: 'Paris is the capital of France.'}]},
  },
];

const evaluator = new ResponseEvaluator({
  threshold: 0.8,
  metricName: 'response_match_score',
});
const result = await evaluator.evaluateInvocations(actual, expected);

result.overallScore; // the mean ROUGE-1 f-measure over the invocations
result.overallEvalStatus === EvalStatus.PASSED;
```

An `EvalMetric` configures the same evaluator from a stored eval definition.
Give either the metric or the loose `threshold` and `metricName` pair, never
both.

```ts
const evaluator = new ResponseEvaluator({
  evalMetric: {
    metricName: 'response_match_score',
    criterion: {threshold: 0.7},
  },
});
```

## Reading the result

`evaluateInvocations` returns one `PerInvocationResult` for every invocation
you passed, in order, each holding the invocation it scored. An invocation
passes when its score is greater than or equal to the threshold.
`overallScore` is the mean of the scores, and `overallEvalStatus` applies the
same threshold to that mean.

An invocation the metric could not score keeps `score` undefined and gets
`EvalStatus.NOT_EVALUATED`. It never counts as a zero, and it is left out of
the mean. When no invocation could be scored, `overallScore` is undefined too.

## Scoring coherence

The Vertex AI Gen AI evaluation service has no JavaScript SDK, so this metric
needs a `VertexAiEvalClient` that you supply. `ResponseEvaluator` rejects the
metric without one, and sends the client one request per invocation.

```ts
import {
  ResponseEvaluator,
  VertexAiEvalClient,
  VertexAiEvalRequest,
  VertexEvaluationResult,
} from '@google/adk';

class MyEvalClient implements VertexAiEvalClient {
  async evaluate(
    request: VertexAiEvalRequest,
  ): Promise<VertexEvaluationResult> {
    // Call the service with request.dataset and request.metrics, then return
    // its summary metrics.
    return {summaryMetrics: [{meanScore: 4}]};
  }
}

const evaluator = new ResponseEvaluator({
  threshold: 3,
  metricName: 'response_evaluation_score',
  evalClient: new MyEvalClient(),
});
```

Your client owns authentication. ADK reads no credentials of its own for this
metric.

## Differences from adk-python

- The ROUGE tokenizer does not stem tokens. `adk-python` uses `rouge_score`,
  which stems tokens longer than three characters with NLTK's Porter stemmer.
  Two inflections of one word therefore match in Python and do not match here.
- Text written without spaces is segmented into words by `Intl.Segmenter`.
  `adk-python` splits such text one token per character, so scores for Chinese,
  Japanese, Thai, Lao and Khmer differ between the two.
- `adk-python` builds a Vertex AI client from the environment. Here you supply
  the client, so ADK reads no credentials.
