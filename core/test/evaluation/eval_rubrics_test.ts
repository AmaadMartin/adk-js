/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  addRubricsToInvocation,
  copyEvalCaseRubricsToActualInvocations,
  copyInvocationRubricsToActualInvocations,
  EvalCase,
  InputValidationError,
  Invocation,
  Rubric,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

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
