# Hallucinations v1

`HallucinationsV1Evaluator` asks a judge model whether every sentence an agent
wrote is supported by the context the agent had. Reach for it when the answer
must stay inside its evidence: a retrieval agent that must not invent a fact
its tool never returned, or a tool-using agent that must not narrate a result
before the tool answers.

## Introduction

A correctness metric compares an answer against a golden answer. That does not
catch the common failure of a grounded agent, which is a fluent answer that
adds a detail nothing in the conversation supports. This metric has no golden
answer. It grades the agent's own words against the agent's own evidence.

Each natural language response is graded in two judge calls. The first asks the
judge to split the response into sentences. The second gives the judge the
context and those sentences, and asks for one label per sentence: `supported`,
`unsupported`, `contradictory`, `disputed` or `not_applicable`. The response's
score is the Accuracy Score, the fraction of labelled sentences that are
`supported` or `not_applicable`. `not_applicable` covers a sentence that needs
no evidence, such as a greeting or a planning step.

An invocation's score is the mean over the responses that were graded, and
`overallScore` is the mean over the invocations that were scored. Both are in
`[0, 1]`, and a score closer to 1 is better. `overallEvalStatus` compares
`overallScore` against the criterion's `threshold`, so `threshold: 0.9` fails a
case once more than one sentence in ten stops being supported.

Two neighbouring metrics answer different questions.
`FinalResponseMatchV2Evaluator` asks whether the answer matches a golden one,
and needs that golden answer. `TrajectoryEvaluator` asks whether the agent
called the right tools. This metric needs neither, so it grades a case for
which no reference answer exists.

## Get started

The criterion carries the threshold and the judge options. Pass the recorded
invocations; no golden invocations are needed.

```ts
import {
  HallucinationsV1Evaluator,
  PrebuiltMetrics,
  type EvalMetric,
  type Invocation,
} from '@google/adk';

const evalMetric: EvalMetric = {
  metricName: PrebuiltMetrics.HALLUCINATIONS_V1,
  criterion: {
    threshold: 0.8,
    judgeModelOptions: {judgeModel: 'gemini-2.5-flash'},
  },
};

const evaluator = new HallucinationsV1Evaluator(evalMetric);

const actual: Invocation[] = [
  {
    appDetails: {
      agentDetails: {
        root: {name: 'root', instructions: 'Answer from the tool output only.'},
      },
    },
    userContent: {role: 'user', parts: [{text: 'How tall is Mount Everest?'}]},
    intermediateData: {
      invocationEvents: [
        {
          author: 'root',
          content: {
            parts: [
              {
                functionResponse: {
                  name: 'lookup',
                  response: {height: '8849 m'},
                },
              },
            ],
          },
        },
      ],
    },
    finalResponse: {
      role: 'model',
      parts: [{text: 'Mount Everest is 8,849 metres tall.'}],
    },
  },
];

// `overallScore` is the fraction of sentences the judge found supported, and
// `overallEvalStatus` compares it against the criterion's threshold.
const result = await evaluator.evaluateInvocations(actual);
```

Supply your own judge with the second constructor argument. This is how the
unit tests grade offline, and it is the way to grade against a model
`LLMRegistry` does not own.

```ts
const evaluator = new HallucinationsV1Evaluator(evalMetric, myJudgeModel);
```

## What the judge reads as context

The context is assembled from the invocation, not from a golden answer, so what
the agent recorded decides what counts as supported. In order, it holds:

1. The instructions of every agent in `appDetails.agentDetails` that carries
   some, each under its agent name.
2. The text of `userContent`.
3. The tool declarations of every agent, as JSON. An invocation with no
   `appDetails` reports `Agent has no tools.` instead.
4. Every event that came before the response being graded: its text first, then
   its `tool_calls`, then its `tool_outputs`.

A claim the agent could only have got from a tool output is therefore supported
only if that tool output is in the recorded events.

## Grading the intermediate responses

`evaluateIntermediateNlResponses` is false by default, so only the final
response is graded, against every recorded event. Set it to true to grade each
intermediate response as well. Each one is then graded against only the events
that came before it, which is what catches an agent that announces a result
before its tool has returned one.

## Configuring the judge

`judgeModelOptions` holds the judge settings.

| Field              | Default            | What it does                                   |
| ------------------ | ------------------ | ---------------------------------------------- |
| `judgeModel`       | `gemini-2.5-flash` | The model that labels the sentences.           |
| `judgeModelConfig` | none               | The generation config each judge call carries. |

`numSamples` and `parallelismLimit` are accepted and ignored. This metric asks
the judge once per step and grades the steps one at a time, as adk-python's
`HallucinationsV1Evaluator` does.

## When a response is not scored

The evaluator never throws because of the judge. A judge call that fails, that
answers nothing, or that answers unintelligibly leaves that response ungraded,
and the remaining responses still count. A response is ungraded when:

- the segmenter call throws, or answers with no text;
- the segmenter finds no `<sentence>` tag in the response;
- the validator call throws, or answers with no text;
- no sentence carried a label this metric recognises.

An invocation whose responses were all ungraded, or that has no natural
language response at all, reports no score and the status `NOT_EVALUATED`. So
does the whole result when no invocation scored.

Two inputs do throw an `InputValidationError`, because they are programming
errors rather than judge failures: a metric whose criterion is not a
`HallucinationsCriterion`, and an `expectedInvocations` list of a different
length from `actualInvocations`.
