/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InputValidationError,
  addRubricsToInvocation,
  copyEvalCaseRubricsToActualInvocations,
  copyInvocationRubricsToActualInvocations,
  type EvalCase,
  type Invocation,
  type Rubric,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function rubric(rubricId: string): Rubric {
  return {rubricId, rubricContent: {textProperty: `Property ${rubricId}.`}};
}

function invocation(rubrics?: Rubric[]): Invocation {
  return {
    invocationId: 'invocation_1',
    userContent: {parts: [{text: 'hello'}]},
    creationTimestamp: 0,
    ...(rubrics ? {rubrics} : {}),
  };
}

function evalCase(rubrics?: Rubric[]): EvalCase {
  return {evalId: 'case_1', ...(rubrics ? {rubrics} : {})};
}

describe('addRubricsToInvocation', () => {
  it('starts a rubric list the invocation does not have', () => {
    const target = invocation();

    addRubricsToInvocation(target, [rubric('a')]);

    expect(target.rubrics).toEqual([rubric('a')]);
  });

  it('appends to the rubrics the invocation already carries', () => {
    const target = invocation([rubric('a')]);

    addRubricsToInvocation(target, [rubric('b'), rubric('c')]);

    expect(target.rubrics?.map((r) => r.rubricId)).toEqual(['a', 'b', 'c']);
  });

  it('rejects a rubric id the invocation already carries', () => {
    const target = invocation([rubric('a')]);

    expect(() => addRubricsToInvocation(target, [rubric('a')])).toThrow(
      new InputValidationError("Rubric with rubric_id 'a' already exists."),
    );
  });

  it('rejects a duplicate inside the list being added', () => {
    const target = invocation();

    expect(() =>
      addRubricsToInvocation(target, [rubric('a'), rubric('a')]),
    ).toThrow(InputValidationError);
  });
});

describe('copyEvalCaseRubricsToActualInvocations', () => {
  it('copies the case rubrics onto every invocation', () => {
    const invocations = [invocation(), invocation()];

    copyEvalCaseRubricsToActualInvocations(
      evalCase([rubric('a')]),
      invocations,
    );

    expect(invocations.map((i) => i.rubrics)).toEqual([
      [rubric('a')],
      [rubric('a')],
    ]);
  });

  it('leaves the invocations alone when the case has no rubrics', () => {
    const invocations = [invocation()];

    copyEvalCaseRubricsToActualInvocations(evalCase(), invocations);

    expect(invocations[0].rubrics).toBeUndefined();
  });

  it('leaves the invocations alone when the case rubric list is empty', () => {
    const invocations = [invocation()];

    copyEvalCaseRubricsToActualInvocations(evalCase([]), invocations);

    expect(invocations[0].rubrics).toBeUndefined();
  });
});

describe('copyInvocationRubricsToActualInvocations', () => {
  it('copies each expected invocation rubric onto its actual invocation', () => {
    const actual = [invocation(), invocation()];

    copyInvocationRubricsToActualInvocations(
      [invocation([rubric('a')]), invocation([rubric('b')])],
      actual,
    );

    expect(actual.map((i) => i.rubrics)).toEqual([
      [rubric('a')],
      [rubric('b')],
    ]);
  });

  it('stops at the shorter list', () => {
    const actual = [invocation()];

    copyInvocationRubricsToActualInvocations(
      [invocation([rubric('a')]), invocation([rubric('b')])],
      actual,
    );

    expect(actual[0].rubrics).toEqual([rubric('a')]);
  });

  it('skips an expected invocation that carries no rubrics', () => {
    const actual = [invocation(), invocation()];

    copyInvocationRubricsToActualInvocations(
      [invocation(), invocation([rubric('b')])],
      actual,
    );

    expect(actual[0].rubrics).toBeUndefined();
    expect(actual[1].rubrics).toEqual([rubric('b')]);
  });

  it('does nothing when there are no expected invocations', () => {
    const actual = [invocation()];

    copyInvocationRubricsToActualInvocations(undefined, actual);

    expect(actual[0].rubrics).toBeUndefined();
  });
});
