/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalStatus,
  InputValidationError,
  Invocation,
  emptyEvaluationResult,
  getEvalStatus,
  getTextFromContent,
  validateInvocationLengths,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function createInvocation(text: string): Invocation {
  return {userContent: {role: 'user', parts: [{text}]}};
}

describe('getEvalStatus', () => {
  it.each([
    {score: 0.8, threshold: 0.8, expected: EvalStatus.PASSED},
    {score: 0.7, threshold: 0.8, expected: EvalStatus.FAILED},
    {score: 0.8, threshold: 0.9, expected: EvalStatus.FAILED},
    {score: 0.9, threshold: 0.8, expected: EvalStatus.PASSED},
  ])('scores $score against $threshold', ({score, threshold, expected}) => {
    expect(getEvalStatus(score, threshold)).toBe(expected);
  });

  it('reports an absent score as not evaluated', () => {
    expect(getEvalStatus(undefined, 0.8)).toBe(EvalStatus.NOT_EVALUATED);
  });
});

describe('getTextFromContent', () => {
  it('joins the text parts with newlines', () => {
    const text = getTextFromContent({
      role: 'model',
      parts: [{text: 'This is a test text.'}, {text: 'This is another one.'}],
    });

    expect(text).toBe('This is a test text.\nThis is another one.');
  });

  it('skips the parts that carry no text', () => {
    const text = getTextFromContent({
      role: 'model',
      parts: [
        {functionCall: {name: 'lookup', args: {}}},
        {text: 'the answer'},
        {inlineData: {mimeType: 'image/png', data: ''}},
      ],
    });

    expect(text).toBe('the answer');
  });

  it('returns an empty string for absent content', () => {
    expect(getTextFromContent(undefined)).toBe('');
  });
});

describe('validateInvocationLengths', () => {
  it('accepts two lists of the same length', () => {
    expect(() =>
      validateInvocationLengths(
        [createInvocation('a'), createInvocation('b')],
        [createInvocation('a'), createInvocation('b')],
      ),
    ).not.toThrow();
  });

  it('accepts absent expected invocations', () => {
    expect(() =>
      validateInvocationLengths([createInvocation('a')], undefined),
    ).not.toThrow();
  });

  it('rejects lists of different lengths', () => {
    expect(() =>
      validateInvocationLengths(
        [createInvocation('a'), createInvocation('b')],
        [createInvocation('a')],
      ),
    ).toThrow(InputValidationError);
  });
});

describe('emptyEvaluationResult', () => {
  it('reports nothing evaluated', () => {
    expect(emptyEvaluationResult()).toEqual({
      overallEvalStatus: EvalStatus.NOT_EVALUATED,
      perInvocationResults: [],
    });
  });
});
