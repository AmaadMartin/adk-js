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

describe('evaluator', () => {
  describe('validateInvocationLengths', () => {
    it('accepts lists of the same length', () => {
      expect(() =>
        validateInvocationLengths([INVOCATION], [INVOCATION]),
      ).not.toThrow();
    });

    it('accepts an absent expected list', () => {
      expect(() => validateInvocationLengths([INVOCATION])).not.toThrow();
    });

    it('rejects lists of different lengths, naming both', () => {
      expect(() =>
        validateInvocationLengths([INVOCATION, INVOCATION], [INVOCATION]),
      ).toThrow(
        new InputValidationError(
          'actualInvocations and expectedInvocations must have the same' +
            ' length; got 2 and 1.',
        ),
      );
    });
  });
});
