/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {rouge1Score, tokenize} from '../../src/evaluation/rouge_scorer.js';

describe('rouge_scorer', () => {
  describe('tokenize', () => {
    it('lowercases and drops punctuation', () => {
      expect(tokenize('Hello, World!')).toEqual(['hello', 'world']);
    });

    it('returns no token for text without a letter or digit', () => {
      expect(tokenize('')).toEqual([]);
      expect(tokenize('... --- !!!')).toEqual([]);
    });

    it('keeps digits and accented letters as tokens', () => {
      expect(tokenize('Café serves 2 crêpes')).toEqual([
        'café',
        'serves',
        '2',
        'crêpes',
      ]);
    });
  });

  describe('rouge1Score', () => {
    it('scores identical text 1', () => {
      expect(rouge1Score('the cat sat', 'the cat sat')).toEqual({
        precision: 1,
        recall: 1,
        fmeasure: 1,
      });
    });

    it('scores text with no shared word 0', () => {
      expect(rouge1Score('alpha beta', 'gamma delta')).toEqual({
        precision: 0,
        recall: 0,
        fmeasure: 0,
      });
    });

    it('scores partial overlap by the shared words', () => {
      const score = rouge1Score('the cat sat', 'the cat ran');
      expect(score.precision).toBeCloseTo(2 / 3);
      expect(score.recall).toBeCloseTo(2 / 3);
      expect(score.fmeasure).toBeCloseTo(2 / 3);
    });

    it('reports precision and recall separately when the lengths differ', () => {
      const score = rouge1Score('the cat sat on the mat', 'the cat');
      expect(score.precision).toBeCloseTo(2 / 6);
      expect(score.recall).toBeCloseTo(1);
      expect(score.fmeasure).toBeCloseTo(0.5);
    });

    it('ignores word order', () => {
      expect(rouge1Score('a b c', 'c b a').fmeasure).toBe(1);
    });

    it('clips a repeated word to how often the reference repeats it', () => {
      const score = rouge1Score('the the the', 'the cat');
      expect(score.precision).toBeCloseTo(1 / 3);
      expect(score.recall).toBeCloseTo(1 / 2);
    });

    it('ignores case and punctuation', () => {
      expect(rouge1Score('Hello, world!', 'hello world').fmeasure).toBe(1);
    });

    it('scores an empty or punctuation-only side 0', () => {
      expect(rouge1Score('', 'the cat')).toEqual({
        precision: 0,
        recall: 0,
        fmeasure: 0,
      });
      expect(rouge1Score('the cat', '')).toEqual({
        precision: 0,
        recall: 0,
        fmeasure: 0,
      });
      expect(rouge1Score('...', '...')).toEqual({
        precision: 0,
        recall: 0,
        fmeasure: 0,
      });
    });

    it('matches an accented word as one token', () => {
      expect(rouge1Score('le café', 'le café').fmeasure).toBe(1);
      expect(rouge1Score('le café', 'le thé').fmeasure).toBeCloseTo(0.5);
    });
  });
});
