/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalCase,
  InputValidationError,
  Invocation,
  Rubric,
  parseRubric,
  parseRubricScore,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {
  addRubricsToInvocation,
  copyEvalCaseRubricsToActualInvocations,
  copyInvocationRubricsToActualInvocations,
} from '../../src/evaluation/eval_rubrics.js';

function invocation(id: string, rubrics?: Rubric[]): Invocation {
  return {
    invocationId: id,
    userContent: {role: 'user', parts: [{text: `ask ${id}`}]},
    finalResponse: {role: 'model', parts: [{text: `reply ${id}`}]},
    rubrics,
  };
}

function rubric(rubricId: string): Rubric {
  return {rubricId, rubricContent: {textProperty: `property of ${rubricId}`}};
}

function buildEvalCase(
  evalId: string,
  turns = 1,
  extra: Partial<EvalCase> = {},
): EvalCase {
  return {
    evalId,
    conversation: Array.from({length: turns}, (unused, index) =>
      invocation(`${evalId}-turn-${index}`),
    ),
    creationTimestamp: 0,
    ...extra,
  };
}

describe('addRubricsToInvocation', () => {
  it('creates the rubric list when the invocation has none', () => {
    const target = invocation('target');

    addRubricsToInvocation(target, [rubric('a'), rubric('b')]);

    expect(target.rubrics?.map((entry) => entry.rubricId)).toEqual(['a', 'b']);
  });

  it('appends to a list the invocation already carries', () => {
    const target = invocation('target', [rubric('a')]);

    addRubricsToInvocation(target, [rubric('b')]);

    expect(target.rubrics?.map((entry) => entry.rubricId)).toEqual(['a', 'b']);
  });

  it('rejects a rubric id the invocation already carries', () => {
    const target = invocation('target', [rubric('a')]);

    expect(() => addRubricsToInvocation(target, [rubric('a')])).toThrow(
      new InputValidationError("Rubric with rubric_id 'a' already exists."),
    );
  });

  it('rejects a rubric id repeated inside the batch being added', () => {
    const target = invocation('target');

    expect(() =>
      addRubricsToInvocation(target, [rubric('a'), rubric('a')]),
    ).toThrow(
      new InputValidationError("Rubric with rubric_id 'a' already exists."),
    );
  });
});

describe('copyEvalCaseRubricsToActualInvocations', () => {
  it('copies the case rubrics onto every actual invocation', () => {
    const actual = [invocation('a'), invocation('b')];

    copyEvalCaseRubricsToActualInvocations(
      buildEvalCase('case1', 1, {rubrics: [rubric('shared')]}),
      actual,
    );

    for (const target of actual) {
      expect(target.rubrics?.map((entry) => entry.rubricId)).toEqual([
        'shared',
      ]);
    }
  });

  it('does nothing when the case carries no rubrics', () => {
    const actual = [invocation('a')];

    copyEvalCaseRubricsToActualInvocations(buildEvalCase('case1'), actual);

    expect(actual[0].rubrics).toBeUndefined();
  });
});

describe('copyInvocationRubricsToActualInvocations', () => {
  it('copies each expected invocation rubric onto its actual counterpart', () => {
    const actual = [invocation('a'), invocation('b')];
    const expected = [
      invocation('expected-a', [rubric('first')]),
      invocation('expected-b'),
    ];

    copyInvocationRubricsToActualInvocations(expected, actual);

    expect(actual[0].rubrics?.map((entry) => entry.rubricId)).toEqual([
      'first',
    ]);
    expect(actual[1].rubrics).toBeUndefined();
  });

  it('does nothing when there are no expected invocations', () => {
    const actual = [invocation('a')];

    copyInvocationRubricsToActualInvocations(undefined, actual);

    expect(actual[0].rubrics).toBeUndefined();
  });
});

describe('parseRubric', () => {
  it('accepts the adk-python spelling of every field', () => {
    expect(
      parseRubric({
        rubric_id: 'grammar',
        rubric_content: {text_property: 'The response is grammatical.'},
        description: 'Scores 1 when the grammar is correct.',
        type: 'FINAL_RESPONSE_QUALITY',
      }),
    ).toEqual({
      rubricId: 'grammar',
      rubricContent: {textProperty: 'The response is grammatical.'},
      description: 'Scores 1 when the grammar is correct.',
      type: 'FINAL_RESPONSE_QUALITY',
    });
  });

  it('accepts the camelCase spelling of every field', () => {
    expect(
      parseRubric({
        rubricId: 'grammar',
        rubricContent: {textProperty: 'The response is grammatical.'},
      }),
    ).toEqual({
      rubricId: 'grammar',
      rubricContent: {textProperty: 'The response is grammatical.'},
    });
  });

  it('accepts a null text property', () => {
    expect(
      parseRubric({rubric_id: 'g', rubric_content: {text_property: null}}),
    ).toEqual({rubricId: 'g', rubricContent: {}});
  });

  it('rejects a rubric that names no id', () => {
    expect(() => parseRubric({rubric_content: {}})).toThrow(
      /Invalid Rubric: rubricId: /,
    );
    expect(() => parseRubric({rubric_content: {}})).toThrow(
      InputValidationError,
    );
  });

  it('rejects a rubric that names no content', () => {
    expect(() => parseRubric({rubric_id: 'g'})).toThrow(
      /Invalid Rubric: rubricContent: /,
    );
  });

  it('rejects an unrecognized key', () => {
    expect(() =>
      parseRubric({rubric_id: 'g', rubric_content: {}, weight: 2}),
    ).toThrow('Invalid Rubric: Unrecognized key: "weight"');
  });

  it('rejects an unrecognized key inside the rubric content', () => {
    expect(() =>
      parseRubric({rubric_id: 'g', rubric_content: {weight: 2}}),
    ).toThrow('Invalid Rubric: rubricContent: Unrecognized key: "weight"');
  });
});

describe('parseRubricScore', () => {
  it('leaves the optional fields undefined when they are absent', () => {
    const score = parseRubricScore({rubric_id: 'g'});

    expect(score).toEqual({rubricId: 'g'});
    expect(score.rationale).toBeUndefined();
    expect(score.score).toBeUndefined();
  });

  it('keeps a score of zero', () => {
    expect(parseRubricScore({rubric_id: 'g', score: 0}).score).toBe(0);
  });

  it('accepts a rationale and a score', () => {
    expect(
      parseRubricScore({rubricId: 'g', rationale: 'It reads well.', score: 1}),
    ).toEqual({rubricId: 'g', rationale: 'It reads well.', score: 1});
  });

  it('rejects a score that is not a number', () => {
    expect(() => parseRubricScore({rubric_id: 'g', score: 'high'})).toThrow(
      /Invalid RubricScore: score: /,
    );
  });
});
