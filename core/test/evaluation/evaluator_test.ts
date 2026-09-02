/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BASE_CRITERION_TYPE,
  emptyEvaluationResult,
  EvalStatus,
  Evaluator,
  getEvalStatus,
  getTextFromContent,
  InputValidationError,
  validateInvocationLengths,
  type ConversationScenario,
  type CriterionType,
  type EvaluationResult,
  type Invocation,
  type PerInvocationResult,
  type RubricScore,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

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

const STRICT_CRITERION_TYPE: CriterionType = {
  name: 'StrictCriterion',
  parse: (raw: unknown) => BASE_CRITERION_TYPE.parse(raw),
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
    expect(Evaluator.criterionType).toBe(BASE_CRITERION_TYPE);
    expect(Evaluator.criterionType.name).toBe('BaseCriterion');
    expect(RecordingEvaluator.criterionType).toBe(BASE_CRITERION_TYPE);
  });

  it('lets a subclass narrow criterionType without touching the base', () => {
    expect(StrictEvaluator.criterionType).toBe(STRICT_CRITERION_TYPE);
    expect(StrictEvaluator.criterionType.name).toBe('StrictCriterion');
    expect(Evaluator.criterionType).toBe(BASE_CRITERION_TYPE);
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

    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
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

    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('accepts a rubric score carrying only its rubric id', () => {
    const rubricScore: RubricScore = {rubricId: 'grounded'};

    expect(rubricScore.score).toBeUndefined();
    expect(rubricScore.rationale).toBeUndefined();
  });
});

describe('getEvalStatus', () => {
  it('reports nothing evaluated for an absent score', () => {
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
    expect(getTextFromContent(undefined)).toBe('');
  });

  it('returns an empty string when the content carries no parts', () => {
    expect(getTextFromContent({})).toBe('');
  });

  it('joins only the text parts, with newlines', () => {
    const content = {
      parts: [
        {text: 'first'},
        {functionCall: {name: 'roll_die', args: {sides: 6}}},
        {text: ''},
        {text: 'second'},
      ],
    };

    expect(getTextFromContent(content)).toBe('first\nsecond');
  });
});
