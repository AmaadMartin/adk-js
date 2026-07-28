/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  RubricContentSchema,
  RubricSchema,
  RubricScoreSchema,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('evaluation/eval_rubrics', () => {
  describe('RubricContentSchema', () => {
    it('parses with the optional textProperty', () => {
      const content = RubricContentSchema.parse({
        textProperty: 'The response is grammatically correct.',
      });
      expect(content.textProperty).toBe(
        'The response is grammatically correct.',
      );
    });

    it('allows textProperty to be omitted', () => {
      const content = RubricContentSchema.parse({});
      expect(content.textProperty).toBeUndefined();
    });

    it('rejects unknown keys (strict)', () => {
      expect(RubricContentSchema.safeParse({unexpected: 1}).success).toBe(
        false,
      );
    });
  });

  describe('RubricSchema', () => {
    it('parses with required and optional fields', () => {
      const rubric = RubricSchema.parse({
        rubricId: 'r1',
        rubricContent: {textProperty: 'criterion'},
        description: 'how to interpret',
        type: 'TOOL_USE_QUALITY',
      });
      expect(rubric.rubricId).toBe('r1');
      expect(rubric.rubricContent.textProperty).toBe('criterion');
      expect(rubric.description).toBe('how to interpret');
      expect(rubric.type).toBe('TOOL_USE_QUALITY');
    });

    it('leaves optional fields undefined', () => {
      const rubric = RubricSchema.parse({
        rubricId: 'r1',
        rubricContent: {},
      });
      expect(rubric.description).toBeUndefined();
      expect(rubric.type).toBeUndefined();
    });

    it('rejects unknown keys (strict)', () => {
      expect(
        RubricSchema.safeParse({
          rubricId: 'r1',
          rubricContent: {},
          extra: true,
        }).success,
      ).toBe(false);
    });
  });

  describe('RubricScoreSchema', () => {
    it('parses with required and optional fields', () => {
      const score = RubricScoreSchema.parse({
        rubricId: 'r1',
        rationale: 'because',
        score: 0.5,
      });
      expect(score).toEqual({rubricId: 'r1', rationale: 'because', score: 0.5});
    });

    it('leaves optional fields undefined', () => {
      const score = RubricScoreSchema.parse({rubricId: 'r1'});
      expect(score.rationale).toBeUndefined();
      expect(score.score).toBeUndefined();
    });

    it('rejects unknown keys (strict)', () => {
      expect(
        RubricScoreSchema.safeParse({rubricId: 'r1', extra: 1}).success,
      ).toBe(false);
    });
  });
});
