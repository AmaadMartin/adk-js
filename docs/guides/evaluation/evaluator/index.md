# Evaluator

`Evaluator` is the contract every evaluation metric implements. Implement it
when you score an agent's invocations with a metric that ADK does not ship.

## Introduction

An eval run produces invocations: one user message, the agent's reply, and the
route the agent took between them. A metric reads those invocations and returns
a score. `Evaluator` is the interface that metric implements, and
`EvaluationResult` is what it returns.

A result has two levels. `perInvocationResults` holds one
`PerInvocationResult` per invocation. `overallScore` and `overallEvalStatus`
describe the eval case as a whole. Both levels carry an `EvalStatus`, whose
numeric values match adk-python, so a serialized status is portable between the
two SDKs.

A rubric-based metric also reports which rubrics it assessed. It attaches
`RubricScore[]` to `rubricScores` on each invocation, and to
`overallRubricScores` on the case. Both fields are optional, and `undefined`
means no rubric assessment happened. An empty array means the opposite: an
assessment ran and produced nothing.

A criterion configures a metric, and ADK reads it from a user-authored eval
config file. That value is untrusted, so the metric names the criterion type it
accepts and lets that type check the value. `BaseCriterion` requires only a
numeric `threshold`. A metric that needs more extends it.

## Get started

A metric implements one method. `validateInvocationLengths` rejects a golden
list that cannot be paired with the actual one. `getEvalStatus` turns a score
into a verdict, and `emptyEvaluationResult` reports that nothing was scored.

```ts
import {
  emptyEvaluationResult,
  getEvalStatus,
  getTextFromContent,
  validateInvocationLengths,
  type EvaluationResult,
  type Evaluator,
  type Invocation,
} from '@google/adk';

const MAX_WORDS = 50;

class WordCountMetric implements Evaluator {
  constructor(private readonly threshold: number) {}

  evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
  ): EvaluationResult {
    validateInvocationLengths(actualInvocations, expectedInvocations);
    if (actualInvocations.length === 0) {
      return emptyEvaluationResult();
    }

    const perInvocationResults = actualInvocations.map((actualInvocation) => {
      const text = getTextFromContent(actualInvocation.finalResponse);
      const score = text.split(/\s+/).length <= MAX_WORDS ? 1 : 0;
      return {
        actualInvocation,
        score,
        evalStatus: getEvalStatus(score, this.threshold),
      };
    });

    const total = perInvocationResults.reduce((sum, r) => sum + r.score, 0);
    const overallScore = total / actualInvocations.length;

    return {
      overallScore,
      overallEvalStatus: getEvalStatus(overallScore, this.threshold),
      perInvocationResults,
    };
  }
}
```

`evaluateInvocations` returns the result directly, or returns a promise. A
metric that calls a judge model returns a promise; a deterministic metric does
not. Callers `await` the result, which is correct for both.

## Criterion types

A criterion type has a `name` and a `validate`. `validate` returns the value as
a criterion of that type, or throws `InputValidationError`.

`BASE_CRITERION_TYPE` is the default. It accepts any object that carries a
finite numeric `threshold`, and it returns that object unchanged, so the extra
fields of a subclass criterion survive the check.

```ts
import {BASE_CRITERION_TYPE, getCriterionType} from '@google/adk';

class WordCountMetric implements Evaluator {
  static readonly criterionType = BASE_CRITERION_TYPE;

  evaluateInvocations(): EvaluationResult {
    return emptyEvaluationResult();
  }
}

const rawCriterion: unknown = JSON.parse('{"threshold": 0.8}');
const criterion = getCriterionType(WordCountMetric).validate(rawCriterion);
```

`getCriterionType` returns the type the class names, or `BASE_CRITERION_TYPE`
when the class names none. A metric that needs more than a threshold declares
its own type:

```ts
import {
  InputValidationError,
  validateBaseCriterion,
  type BaseCriterion,
  type CriterionType,
} from '@google/adk';

interface WordCountCriterion extends BaseCriterion {
  maxWords: number;
}

const WORD_COUNT_CRITERION_TYPE: CriterionType<WordCountCriterion> = {
  name: 'WordCountCriterion',
  validate(value: unknown): WordCountCriterion {
    const criterion = validateBaseCriterion(value);
    if (!('maxWords' in criterion) || typeof criterion.maxWords !== 'number') {
      throw new InputValidationError(
        'A criterion of type `WordCountCriterion` requires a numeric ' +
          '`maxWords`.',
      );
    }
    return {...criterion, maxWords: criterion.maxWords};
  },
};
```

## Multi-turn conversations

`evaluateInvocations` takes an optional third argument, a
`ConversationScenario`. ADK supplies it when a simulated user drove the
conversation, and omits it for a static one. The scenario carries the fixed
first user message, the plan the simulator followed, and the persona it
adopted. A metric that scores a whole conversation reads it. A single-turn
metric ignores it, and may declare only the first two parameters.

## Parity with adk-python

The contract matches `Evaluator` in adk-python
(`src/google/adk/evaluation/evaluator.py`). Field names are camelCase here and
snake_case there. adk-python generates camelCase aliases for its criterion, so
a criterion written in a config file reads the same in both SDKs.

Python binds a criterion type with
`criterion_type: ClassVar[type[BaseCriterion]]`. TypeScript erases interfaces,
so there is no class object to bind. `CriterionType` is the runtime stand-in:
it carries the name Python takes from the class, and the `validate` Python gets
from `model_validate`.
