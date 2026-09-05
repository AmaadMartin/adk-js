/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BASE_CRITERION_TYPE,
  EvalStatus,
  InputValidationError,
  emptyEvaluationResult,
  getCriterionType,
  getEvalStatus,
  getTextFromContent,
  isInvocationEvents,
  validateBaseCriterion,
  validateInvocationLengths,
  type BaseCriterion,
  type ConversationScenario,
  type CriterionType,
  type EvaluationResult,
  type Evaluator,
  type Invocation,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const THRESHOLD_MESSAGE =
  'A criterion of type `BaseCriterion` requires a numeric `threshold`.';

const SCENARIO: ConversationScenario = {
  startingPrompt: 'I need to book a flight.',
  conversationPlan: 'Book a one-way flight, then rent a car.',
  userPersona: {
    id: 'terse_user',
    description: 'Answers in as few words as possible.',
    behaviors: [
      {
        name: 'terse',
        description: 'Keeps every reply short.',
        behaviorInstructions: ['Reply with at most five words.'],
        violationRubrics: ['The reply is longer than five words.'],
      },
    ],
  },
};

/** A criterion type that rejects a threshold the base type accepts. */
const POSITIVE_CRITERION_TYPE: CriterionType<BaseCriterion> = {
  name: 'PositiveCriterion',
  validate(value: unknown): BaseCriterion {
    const criterion = validateBaseCriterion(value);
    if (criterion.threshold <= 0) {
      throw new InputValidationError(
        'A criterion of type `PositiveCriterion` requires a positive ' +
          '`threshold`.',
      );
    }
    return criterion;
  },
};

function invocation(text: string): Invocation {
  return {userContent: {role: 'user', parts: [{text}]}};
}

/** Scores every invocation, and scores higher when a scenario is supplied. */
class RubricMetric implements Evaluator {
  static readonly criterionType = POSITIVE_CRITERION_TYPE;

  evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    conversationScenario?: ConversationScenario,
  ): EvaluationResult {
    validateInvocationLengths(actualInvocations, expectedInvocations);
    const score = conversationScenario === undefined ? 0.25 : 1;
    return {
      overallScore: score,
      overallEvalStatus: getEvalStatus(score, 1),
      overallRubricScores: [
        {rubricId: 'is_polite', rationale: 'polite', score},
      ],
      perInvocationResults: actualInvocations.map((actualInvocation) => ({
        actualInvocation,
        score,
        evalStatus: getEvalStatus(score, 1),
        rubricScores: [{rubricId: 'is_polite', score}],
      })),
    };
  }
}

/** Declares only the first two parameters of the contract. */
class TwoParameterMetric {
  evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
  ): EvaluationResult {
    validateInvocationLengths(actualInvocations, expectedInvocations);
    return {
      overallScore: 1,
      overallEvalStatus: EvalStatus.PASSED,
      perInvocationResults: [],
    };
  }
}

/** Returns its result asynchronously. */
class AsyncMetric implements Evaluator {
  async evaluateInvocations(
    actualInvocations: Invocation[],
  ): Promise<EvaluationResult> {
    return {
      overallScore: actualInvocations.length,
      overallEvalStatus: EvalStatus.PASSED,
      perInvocationResults: [],
    };
  }
}

/** Names no criterion type, as an evaluator that inherits the default does. */
class DefaultCriterionMetric implements Evaluator {
  evaluateInvocations(): EvaluationResult {
    return emptyEvaluationResult();
  }
}

describe('validateInvocationLengths', () => {
  it('accepts an absent expected list', () => {
    expect(() => {
      validateInvocationLengths([invocation('hi')]);
    }).not.toThrow();
  });

  it('accepts two lists of equal length', () => {
    expect(() => {
      validateInvocationLengths([invocation('hi')], [invocation('hello')]);
    }).not.toThrow();
  });

  it('accepts two empty lists', () => {
    expect(() => {
      validateInvocationLengths([], []);
    }).not.toThrow();
  });

  it('rejects a shorter expected list', () => {
    expect(() => {
      validateInvocationLengths([invocation('hi')], []);
    }).toThrow(
      new InputValidationError(
        'actualInvocations and expectedInvocations must have the same ' +
          'length; got 1 and 0.',
      ),
    );
  });

  it('rejects a longer expected list', () => {
    expect(() => {
      validateInvocationLengths([], [invocation('hello')]);
    }).toThrow(
      new InputValidationError(
        'actualInvocations and expectedInvocations must have the same ' +
          'length; got 0 and 1.',
      ),
    );
  });
});

describe('validateBaseCriterion', () => {
  it('returns the criterion', () => {
    expect(validateBaseCriterion({threshold: 0.7})).toEqual({threshold: 0.7});
  });

  it('preserves the keys the interface does not name', () => {
    const criterion = {threshold: 0.7, matchType: 'IN_ORDER'};

    expect(validateBaseCriterion(criterion)).toEqual({
      threshold: 0.7,
      matchType: 'IN_ORDER',
    });
  });

  it('returns the value it was given', () => {
    const criterion = {threshold: 0.7};

    expect(validateBaseCriterion(criterion)).toBe(criterion);
  });

  it('accepts a threshold of zero', () => {
    expect(validateBaseCriterion({threshold: 0})).toEqual({threshold: 0});
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', '0.7'],
    ['a number', 42],
    ['an array', []],
    ['an object with no threshold', {}],
    ['a string threshold', {threshold: '0.7'}],
    ['a NaN threshold', {threshold: Number.NaN}],
    ['an infinite threshold', {threshold: Number.POSITIVE_INFINITY}],
  ])('rejects %s', (_name, value) => {
    expect(() => validateBaseCriterion(value)).toThrow(InputValidationError);
  });

  it('names the criterion type in the message', () => {
    expect(() => validateBaseCriterion({})).toThrow(THRESHOLD_MESSAGE);
    expect(THRESHOLD_MESSAGE).toContain(BASE_CRITERION_TYPE.name);
  });
});

describe('BASE_CRITERION_TYPE', () => {
  it('is named after the criterion it validates', () => {
    expect(BASE_CRITERION_TYPE.name).toBe('BaseCriterion');
  });

  it('validates through validateBaseCriterion', () => {
    expect(BASE_CRITERION_TYPE.validate({threshold: 0.5})).toEqual({
      threshold: 0.5,
    });
  });
});

describe('getCriterionType', () => {
  it('returns the base type for a class that names none', () => {
    expect(getCriterionType(DefaultCriterionMetric)).toBe(BASE_CRITERION_TYPE);
  });

  it('returns the type the class names', () => {
    expect(getCriterionType(RubricMetric)).toBe(POSITIVE_CRITERION_TYPE);
  });

  it('runs the validate of the type the class names', () => {
    const criterion = {threshold: 0};

    expect(getCriterionType(DefaultCriterionMetric).validate(criterion)).toBe(
      criterion,
    );
    expect(() => getCriterionType(RubricMetric).validate(criterion)).toThrow(
      'A criterion of type `PositiveCriterion` requires a positive ' +
        '`threshold`.',
    );
  });
});

describe('getEvalStatus', () => {
  it('reports an absent score as not evaluated', () => {
    expect(getEvalStatus(undefined, 0.5)).toBe(EvalStatus.NOT_EVALUATED);
  });

  it('passes a score equal to the threshold', () => {
    expect(getEvalStatus(0.5, 0.5)).toBe(EvalStatus.PASSED);
  });

  it('fails a score below the threshold', () => {
    expect(getEvalStatus(0.49, 0.5)).toBe(EvalStatus.FAILED);
  });
});

describe('getTextFromContent', () => {
  it('returns an empty string for absent content', () => {
    expect(getTextFromContent()).toBe('');
  });

  it('returns an empty string for content with no parts', () => {
    expect(getTextFromContent({role: 'model'})).toBe('');
  });

  it('skips the parts that carry no text', () => {
    expect(
      getTextFromContent({
        role: 'model',
        parts: [{functionCall: {name: 'search'}}, {text: 'done'}],
      }),
    ).toBe('done');
  });

  it('joins several text parts with newlines', () => {
    expect(
      getTextFromContent({role: 'model', parts: [{text: 'a'}, {text: 'b'}]}),
    ).toBe('a\nb');
  });
});

describe('emptyEvaluationResult', () => {
  it('reports that nothing was evaluated', () => {
    const result = emptyEvaluationResult();

    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.perInvocationResults).toEqual([]);
    expect(result.overallScore).toBeUndefined();
    expect(result.overallRubricScores).toBeUndefined();
  });
});

describe('Evaluator', () => {
  it('carries the rubric scores of a rubric-based metric', async () => {
    const evaluator: Evaluator = new RubricMetric();

    const result = await evaluator.evaluateInvocations([invocation('hi')]);

    expect(result.overallRubricScores).toEqual([
      {rubricId: 'is_polite', rationale: 'polite', score: 0.25},
    ]);
    expect(result.perInvocationResults[0].rubricScores).toEqual([
      {rubricId: 'is_polite', score: 0.25},
    ]);
  });

  it('reads the conversation scenario it is given', async () => {
    const evaluator: Evaluator = new RubricMetric();

    const withoutScenario = await evaluator.evaluateInvocations([
      invocation('hi'),
    ]);
    const withScenario = await evaluator.evaluateInvocations(
      [invocation('hi')],
      undefined,
      SCENARIO,
    );

    expect(withoutScenario.overallScore).toBe(0.25);
    expect(withoutScenario.overallEvalStatus).toBe(EvalStatus.FAILED);
    expect(withScenario.overallScore).toBe(1);
    expect(withScenario.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('accepts an implementation that declares only two parameters', () => {
    const evaluator: Evaluator = new TwoParameterMetric();

    expect(evaluator.evaluateInvocations([invocation('hi')])).toEqual({
      overallScore: 1,
      overallEvalStatus: EvalStatus.PASSED,
      perInvocationResults: [],
    });
  });

  it('accepts an implementation that returns a promise', async () => {
    const evaluator: Evaluator = new AsyncMetric();

    const result = await evaluator.evaluateInvocations([
      invocation('hi'),
      invocation('bye'),
    ]);

    expect(result.overallScore).toBe(2);
  });

  it('rejects mismatched invocation lists through the metric', () => {
    expect(() =>
      new RubricMetric().evaluateInvocations([invocation('hi')], []),
    ).toThrow(InputValidationError);
  });
});

describe('isInvocationEvents', () => {
  it('recognises recorded invocation events', () => {
    expect(isInvocationEvents({invocationEvents: []})).toBe(true);
  });

  it('rejects recorded intermediate data', () => {
    expect(
      isInvocationEvents({
        toolUses: [],
        toolResponses: [],
        intermediateResponses: [],
      }),
    ).toBe(false);
  });
});
