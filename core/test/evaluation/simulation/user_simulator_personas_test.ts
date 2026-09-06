/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getBehaviorInstructionsStr,
  getViolationRubricsStr,
  UserBehaviorSchema,
  UserPersonaSchema,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('evaluation/simulation/user_simulator_personas', () => {
  const behavior = UserBehaviorSchema.parse({
    name: 'impatient',
    description: 'Wants quick answers',
    behaviorInstructions: ['ask concisely', 'push for speed'],
    violationRubrics: ['was verbose', 'was slow'],
  });

  describe('UserBehaviorSchema', () => {
    it('parses required fields', () => {
      expect(behavior.name).toBe('impatient');
      expect(behavior.behaviorInstructions).toEqual([
        'ask concisely',
        'push for speed',
      ]);
      expect(behavior.violationRubrics).toEqual(['was verbose', 'was slow']);
    });

    it('rejects unknown keys (strict)', () => {
      expect(
        UserBehaviorSchema.safeParse({
          name: 'x',
          description: 'y',
          behaviorInstructions: [],
          violationRubrics: [],
          extra: 1,
        }).success,
      ).toBe(false);
    });
  });

  describe('UserPersonaSchema', () => {
    it('parses a persona with behaviors', () => {
      const persona = UserPersonaSchema.parse({
        id: 'persona-1',
        description: 'An impatient user',
        behaviors: [behavior],
      });
      expect(persona.id).toBe('persona-1');
      expect(persona.behaviors).toHaveLength(1);
    });

    it('rejects unknown keys (strict)', () => {
      expect(
        UserPersonaSchema.safeParse({
          id: 'p',
          description: 'd',
          behaviors: [],
          extra: 1,
        }).success,
      ).toBe(false);
    });
  });

  describe('getBehaviorInstructionsStr', () => {
    it('renders a bulleted list', () => {
      expect(getBehaviorInstructionsStr(behavior)).toBe(
        '  * ask concisely\n  * push for speed',
      );
    });

    it('returns an empty string for no instructions', () => {
      const empty = UserBehaviorSchema.parse({
        name: 'x',
        description: 'y',
        behaviorInstructions: [],
        violationRubrics: [],
      });
      expect(getBehaviorInstructionsStr(empty)).toBe('');
    });
  });

  describe('getViolationRubricsStr', () => {
    it('renders a bulleted list', () => {
      expect(getViolationRubricsStr(behavior)).toBe(
        '  * was verbose\n  * was slow',
      );
    });
  });
});
