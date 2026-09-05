# The Evaluator contract

`Evaluator` is the base class every eval metric extends. It fixes what a
metric receives, what it returns, and which criterion shape its configuration
may carry. Reach for it when you write a metric of your own.

## Introduction

An eval run applies several metrics to the same recorded conversation. The
runner has to call each metric the same way and read each result the same way,
so the metrics agree on one contract rather than on a shape per metric.

That contract has three parts. `evaluateInvocations` takes the invocations the
agent under test produced, optionally the golden invocations to score them
against, and optionally the scenario a simulated user followed. It returns an
`EvaluationResult`: one overall score and status, plus a `PerInvocationResult`
for each turn. The static `criterionType` names the criterion the metric
accepts from an eval config, and validates it.

Two of these parts exist for metrics that a rubric drives. A rubric-based
metric reports a per-rubric breakdown next to the numeric score, in
`rubricScores` on each turn and `overallRubricScores` on the whole result. A
multi-turn metric reads `conversationScenario` so it can judge the
conversation against the plan the simulated user followed, rather than against
a golden transcript. A single-turn metric ignores both; every field is
optional, so it never has to name them.

This is the `Evaluator` of `adk-python`, with the same field names and the
same `EvalStatus` numbers, so a serialized result is portable between the two
runtimes. The module is pure: nothing here performs input or output, logs, or
changes the invocations you give it.

## Get started

A metric extends `Evaluator` and implements `evaluateInvocations`. This one
scores a turn on whether the agent answered at all:

```ts
import {
  EvalStatus,
  Evaluator,
  getEvalStatus,
  getTextFromContent,
  type EvaluationResult,
  type Invocation,
} from '@google/adk';

class AnsweredEvaluator extends Evaluator {
  constructor(private readonly threshold: number) {
    super();
  }

  override evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
  ): EvaluationResult {
    const perInvocationResults = actualInvocations.map((actualInvocation) => {
      const score = getTextFromContent(actualInvocation.finalResponse) ? 1 : 0;
      return {
        actualInvocation,
        score,
        evalStatus: getEvalStatus(score, this.threshold),
      };
    });

    const scores = perInvocationResults.map((result) => result.score);
    const overallScore = scores.reduce((a, b) => a + b, 0) / scores.length;

    return {
      overallScore,
      overallEvalStatus: getEvalStatus(overallScore, this.threshold),
      perInvocationResults,
    };
  }
}

const invocation: Invocation = {
  invocationId: 'run-1',
  userContent: {parts: [{text: 'What is the weather in Paris?'}]},
  finalResponse: {parts: [{text: 'It is sunny.'}]},
  creationTimestamp: 0,
};

const result = new AnsweredEvaluator(1).evaluateInvocations([invocation]);

result.overallScore; // 1
result.overallEvalStatus === EvalStatus.PASSED; // true
```

`expectedInvocations` is absent unless the eval case carries golden data, so
each metric decides for itself whether it needs it. When both lists are
present, they must have the same length: pairing them by index would otherwise
truncate one of them silently.

## Reporting rubric scores

A rubric-based metric fills the two rubric fields. Both are optional and
default to absent, which is distinct from an empty array: absent means the
metric is not rubric-based, and `[]` means it is but scored no rubric.

```ts
import {EvalStatus, type EvaluationResult, type Invocation} from '@google/adk';

const invocation: Invocation = {
  invocationId: 'run-1',
  userContent: {parts: [{text: 'What is the weather in Paris?'}]},
  finalResponse: {parts: [{text: 'It is sunny.'}]},
  creationTimestamp: 0,
};

const result: EvaluationResult = {
  overallScore: 0.5,
  overallEvalStatus: EvalStatus.FAILED,
  overallRubricScores: [
    {rubricId: 'grammar', score: 1, rationale: 'Well formed.'},
    {rubricId: 'grounded', score: 0, rationale: 'Cited nothing.'},
  ],
  perInvocationResults: [
    {
      actualInvocation: invocation,
      score: 0.5,
      evalStatus: EvalStatus.FAILED,
      rubricScores: [{rubricId: 'grounded', score: 0}],
    },
  ],
};
```

A `RubricScore` needs only its `rubricId`. Leave `score` absent when the
assessment did not happen, so a reader can tell that apart from a score of 0.
The rubrics themselves travel on `Invocation.rubrics` when they apply to one
turn only.

## Reading the conversation scenario

A multi-turn metric takes the third parameter. It carries the fixed first user
message and the plan the user simulator followed for every later message.

```ts
import {
  EvalStatus,
  Evaluator,
  type ConversationScenario,
  type EvaluationResult,
  type Invocation,
} from '@google/adk';

class TaskSuccessEvaluator extends Evaluator {
  constructor(private readonly judge: (prompt: string) => Promise<number>) {
    super();
  }

  override async evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    conversationScenario?: ConversationScenario,
  ): Promise<EvaluationResult> {
    const plan = conversationScenario?.conversationPlan ?? '';
    const score = await this.judge(plan);

    return {
      overallScore: score,
      overallEvalStatus: score > 0 ? EvalStatus.PASSED : EvalStatus.FAILED,
      perInvocationResults: actualInvocations.map((actualInvocation) => ({
        actualInvocation,
        evalStatus: EvalStatus.NOT_EVALUATED,
      })),
    };
  }
}
```

`evaluateInvocations` may return the result or a promise of it, so a metric
that calls a judge model declares it `async`. The runner awaits either.

## Declaring the criterion type

`criterionType` is a static member, so it binds per class and a subclass
inherits it. A `CriterionType` is a function that validates the criterion an
eval config supplied. It defaults to `parseBaseCriterion`, which accepts any
object carrying a finite numeric `threshold` and keeps every other key.

```ts
import {Evaluator, parseBaseCriterion} from '@google/adk';

Evaluator.criterionType === parseBaseCriterion; // true

Evaluator.criterionType({threshold: 0.7, matchType: 'EXACT'});
// {threshold: 0.7, matchType: 'EXACT'}

Evaluator.criterionType({});
// throws InputValidationError: Expected a criterion of type `BaseCriterion`.
```

A metric that needs more than a threshold overrides the binding with its own
`CriterionType`, and validates the criterion its configuration supplied:

```ts
import {
  emptyEvaluationResult,
  Evaluator,
  InputValidationError,
  isBaseCriterion,
  type BaseCriterion,
  type CriterionType,
  type EvaluationResult,
} from '@google/adk';

interface MatchCriterion extends BaseCriterion {
  matchType: 'EXACT' | 'IN_ORDER';
}

function isMatchCriterion(raw: unknown): raw is MatchCriterion {
  return (
    isBaseCriterion(raw) &&
    'matchType' in raw &&
    (raw.matchType === 'EXACT' || raw.matchType === 'IN_ORDER')
  );
}

const MATCH_CRITERION_TYPE: CriterionType<MatchCriterion> = (raw: unknown) => {
  if (!isMatchCriterion(raw)) {
    throw new InputValidationError(
      'Expected a criterion of type `MatchCriterion`.',
    );
  }
  return raw;
};

class MatchEvaluator extends Evaluator {
  static override readonly criterionType: CriterionType = MATCH_CRITERION_TYPE;

  override evaluateInvocations(): EvaluationResult {
    return emptyEvaluationResult();
  }
}
```

A `CriterionType` takes `unknown`, because an eval config is user-authored JSON
or YAML. It narrows through a type guard rather than a cast, and it returns the
value unchanged so that the extra keys a config carries survive. It never
echoes the value back in the error message.
