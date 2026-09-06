/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  emptyEvaluationResult,
  EvalStatus,
  Evaluator,
  InputValidationError,
  parseBaseCriterion,
  type ConversationScenario,
  type CriterionType,
  type EvaluationResult,
  type Invocation,
  type PerInvocationResult,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {validateInvocationLengths} from '../../src/evaluation/evaluator.js';

const INVOCATION: Invocation = {
  invocationId: '',
  userContent: {parts: [{text: 'User input here.'}]},
  creationTimestamp: 0,
};

const SCENARIO: ConversationScenario = {
  startingPrompt: 'I need to book a flight.',
  conversationPlan: 'Book SFO to LAX, then rent a car.',
};

/** The arguments one `evaluateInvocations` call received. */
interface RecordedCall {
  actualInvocations: Invocation[];
  expectedInvocations?: Invocation[];
  conversationScenario?: ConversationScenario;
}

/** An evaluator that records its arguments instead of scoring anything. */
class RecordingEvaluator extends Evaluator {
  readonly calls: RecordedCall[] = [];

  override evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    conversationScenario?: ConversationScenario,
  ): EvaluationResult {
    this.calls.push({
      actualInvocations,
      expectedInvocations,
      conversationScenario,
    });
    return emptyEvaluationResult();
  }
}

const STRICT_CRITERION_TYPE: CriterionType = (raw: unknown) => {
  const criterion = parseBaseCriterion(raw);
  if (criterion.threshold < 1) {
    throw new InputValidationError(
      'Expected a criterion of type `StrictCriterion`.',
    );
  }
  return criterion;
};

/** An evaluator that narrows the criterion its config may carry. */
class StrictEvaluator extends Evaluator {
  static override readonly criterionType: CriterionType = STRICT_CRITERION_TYPE;

  override evaluateInvocations(): EvaluationResult {
    return emptyEvaluationResult();
  }
}

/** An evaluator that resolves its result, pinning the awaitable half. */
class AsyncEvaluator extends Evaluator {
  override async evaluateInvocations(): Promise<EvaluationResult> {
    return {
      overallScore: 1,
      overallEvalStatus: EvalStatus.PASSED,
      perInvocationResults: [],
    };
  }
}

describe('validateInvocationLengths', () => {
  it('accepts absent expected invocations', () => {
    expect(() => validateInvocationLengths([INVOCATION])).not.toThrow();
  });

  it('accepts lists of the same length', () => {
    expect(() =>
      validateInvocationLengths([INVOCATION], [INVOCATION]),
    ).not.toThrow();
  });

  it('rejects lists of different lengths, naming both lengths', () => {
    expect(() => validateInvocationLengths([INVOCATION], [])).toThrowError(
      new InputValidationError(
        'actualInvocations and expectedInvocations must have the same length; ' +
          'got 1 and 0.',
      ),
    );
  });

  it('accepts two empty lists', () => {
    expect(() => validateInvocationLengths([], [])).not.toThrow();
  });
});

describe('Evaluator', () => {
  it('binds criterionType to the base criterion by default', () => {
    expect(Evaluator.criterionType).toBe(parseBaseCriterion);
    expect(RecordingEvaluator.criterionType).toBe(parseBaseCriterion);
    expect(Evaluator.criterionType({threshold: 0.5})).toEqual({threshold: 0.5});
  });

  it('lets a subclass narrow criterionType without touching the base', () => {
    expect(StrictEvaluator.criterionType).toBe(STRICT_CRITERION_TYPE);
    expect(() => StrictEvaluator.criterionType({threshold: 0.5})).toThrowError(
      new InputValidationError(
        'Expected a criterion of type `StrictCriterion`.',
      ),
    );
    expect(Evaluator.criterionType).toBe(parseBaseCriterion);
    expect(Evaluator.criterionType({threshold: 0.5})).toEqual({threshold: 0.5});
  });

  it('passes the conversation scenario as the third argument', () => {
    const recorder = new RecordingEvaluator();
    const evaluator: Evaluator = recorder;

    evaluator.evaluateInvocations([INVOCATION], [INVOCATION], SCENARIO);

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].conversationScenario).toEqual({
      startingPrompt: 'I need to book a flight.',
      conversationPlan: 'Book SFO to LAX, then rent a car.',
    });
    expect(recorder.calls[0].expectedInvocations).toEqual([INVOCATION]);
  });

  it('leaves the conversation scenario undefined for a two-argument call', () => {
    const recorder = new RecordingEvaluator();
    const evaluator: Evaluator = recorder;

    evaluator.evaluateInvocations([INVOCATION], [INVOCATION]);

    expect(recorder.calls[0].conversationScenario).toBeUndefined();
  });

  it('accepts a subclass that returns a promise', async () => {
    const evaluator: Evaluator = new AsyncEvaluator();

    const result = await evaluator.evaluateInvocations([INVOCATION]);

    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(result.overallScore).toBe(1);
  });
});

describe('EvaluationResult', () => {
  it('round-trips the overall rubric scores through JSON', () => {
    const result: EvaluationResult = {
      overallScore: 0.5,
      overallEvalStatus: EvalStatus.FAILED,
      overallRubricScores: [
        {rubricId: 'grammar', score: 1, rationale: 'Well formed.'},
        {rubricId: 'grounded', score: 0, rationale: 'Cited nothing.'},
      ],
      perInvocationResults: [],
    };

    expect(JSON.parse(JSON.stringify(result))).toEqual({
      overallScore: 0.5,
      overallEvalStatus: 2,
      overallRubricScores: [
        {rubricId: 'grammar', score: 1, rationale: 'Well formed.'},
        {rubricId: 'grounded', score: 0, rationale: 'Cited nothing.'},
      ],
      perInvocationResults: [],
    });
  });

  it('leaves the overall rubric scores unset on an empty result', () => {
    const result = emptyEvaluationResult();

    expect(result.overallRubricScores).toBeUndefined();
    expect(result.perInvocationResults).toEqual([]);
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
  });
});

describe('PerInvocationResult', () => {
  it('round-trips the per-invocation rubric scores through JSON', () => {
    const result: PerInvocationResult = {
      actualInvocation: INVOCATION,
      expectedInvocation: INVOCATION,
      score: 0.5,
      evalStatus: EvalStatus.FAILED,
      rubricScores: [{rubricId: 'grounded', score: 0}],
    };

    expect(JSON.parse(JSON.stringify(result))).toEqual({
      actualInvocation: INVOCATION,
      expectedInvocation: INVOCATION,
      score: 0.5,
      evalStatus: 2,
      rubricScores: [{rubricId: 'grounded', score: 0}],
    });
  });

  it('serializes a rubric score with no score as the id alone', () => {
    const result: PerInvocationResult = {
      actualInvocation: INVOCATION,
      evalStatus: EvalStatus.NOT_EVALUATED,
      rubricScores: [{rubricId: 'grounded'}],
    };

    expect(JSON.parse(JSON.stringify(result)).rubricScores).toEqual([
      {rubricId: 'grounded'},
    ]);
  });
});
