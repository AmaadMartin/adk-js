/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError, parseRubric, parseRubricScore} from '@google/adk';
import {describe, expect, it} from 'vitest';

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
