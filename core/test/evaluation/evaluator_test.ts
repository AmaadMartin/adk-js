/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError, type Invocation} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {validateInvocationLengths} from '../../src/evaluation/evaluator.js';

const INVOCATION: Invocation = {
  userContent: {parts: [{text: 'User input here.'}]},
};

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
});
