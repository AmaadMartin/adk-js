/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cases the adk-python reference tests have no reason to cover: the wire
 * aliases adk-js accepts, and the empty-list rendering the prompt helpers
 * fall back to.
 */

import {
  behaviorInstructionsText,
  isInputValidationError,
  userBehaviorModel,
  userPersonaModel,
  violationRubricsText,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const EMPTY_BEHAVIOR = {
  name: 'empty',
  description: 'Contributes no prompt text.',
  behaviorInstructions: [],
  violationRubrics: [],
};

describe('prompt text helpers', () => {
  it('render an empty string for an empty list', () => {
    expect(behaviorInstructionsText(EMPTY_BEHAVIOR)).toBe('');
    expect(violationRubricsText(EMPTY_BEHAVIOR)).toBe('');
  });
});

describe('userBehaviorModel', () => {
  it('populates the camelCase properties from snake_case keys', () => {
    const behavior = userBehaviorModel.parse({
      name: 'test_behavior',
      description: 'Test behavior description.',
      behavior_instructions: ['instruction1'],
      violation_rubrics: ['violation1'],
    });

    expect(behavior.behaviorInstructions).toEqual(['instruction1']);
    expect(behavior.violationRubrics).toEqual(['violation1']);
  });

  it('rejects an unrecognized key', () => {
    let caught: unknown;
    try {
      userBehaviorModel.parse({
        name: 'test_behavior',
        description: 'Test behavior description.',
        behaviorInstructions: [],
        violationRubrics: [],
        behaviourInstructions: [],
      });
    } catch (error: unknown) {
      caught = error;
    }

    if (!isInputValidationError(caught)) {
      expect.fail(`expected an InputValidationError, got ${String(caught)}`);
    }
    expect(caught.message).toContain('behaviourInstructions');
  });
});

describe('userPersonaModel', () => {
  it('rejects a persona whose behaviors are not behaviors', () => {
    let caught: unknown;
    try {
      userPersonaModel.parse({
        id: 'CUSTOM',
        description: 'Inline persona.',
        behaviors: ['Be terse'],
      });
    } catch (error: unknown) {
      caught = error;
    }

    if (!isInputValidationError(caught)) {
      expect.fail(`expected an InputValidationError, got ${String(caught)}`);
    }
    expect(caught.message).toContain('behaviors.0');
  });
});
