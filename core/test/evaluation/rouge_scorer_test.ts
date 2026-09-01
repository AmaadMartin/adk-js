/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {rouge1Score, tokenizeForRouge} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('tokenizeForRouge', () => {
  it('lowercases and drops punctuation', () => {
    expect(tokenizeForRouge('This is a Test, really!')).toEqual([
      'this',
      'is',
      'a',
      'test',
      'really',
    ]);
  });

  it('segments Chinese text written without spaces into words', () => {
    expect(tokenizeForRouge('北京大学')).toEqual(['北京', '大学']);
  });

  it('segments Thai text written without spaces into words', () => {
    expect(tokenizeForRouge('สวัสดีครับ')).toEqual(['สวัสดี', 'ครับ']);
  });

  it('folds full-width characters to their half-width spelling', () => {
    expect(tokenizeForRouge('ＴＥＳＴ')).toEqual(['test']);
  });

  it('returns no tokens for text with no word characters', () => {
    expect(tokenizeForRouge('  ... !!  ')).toEqual([]);
  });
});

describe('rouge1Score', () => {
  it('scores the adk-python reference pair', () => {
    const score = rouge1Score(
      'This is a test candidate response.',
      'This is a test reference.',
    );

    expect(score.precision).toBeCloseTo(4 / 6);
    expect(score.recall).toBeCloseTo(4 / 5);
    expect(score.fmeasure).toBeCloseTo(8 / 11);
  });

  it('scores disjoint texts as zero', () => {
    expect(rouge1Score('alpha beta', 'gamma delta')).toEqual({
      precision: 0,
      recall: 0,
      fmeasure: 0,
    });
  });

  it('scores an empty candidate as zero', () => {
    expect(rouge1Score('', 'gamma delta')).toEqual({
      precision: 0,
      recall: 0,
      fmeasure: 0,
    });
  });

  it('scores an empty reference as zero', () => {
    expect(rouge1Score('alpha beta', '')).toEqual({
      precision: 0,
      recall: 0,
      fmeasure: 0,
    });
  });

  it('counts a repeated candidate token only as often as the reference has it', () => {
    const score = rouge1Score('test test test', 'test');

    expect(score.precision).toBeCloseTo(1 / 3);
    expect(score.recall).toBe(1);
    expect(score.fmeasure).toBeCloseTo(0.5);
  });

  it('ignores word order', () => {
    expect(rouge1Score('alpha beta gamma', 'gamma alpha beta').fmeasure).toBe(
      1,
    );
  });

  it('scores a Thai text against itself as one', () => {
    expect(rouge1Score('สวัสดีครับ', 'สวัสดีครับ').fmeasure).toBe(1);
  });

  it('scores Chinese text by word overlap', () => {
    const score = rouge1Score('北京大学', '北京');

    expect(score.precision).toBeCloseTo(1 / 2);
    expect(score.recall).toBe(1);
  });
});
