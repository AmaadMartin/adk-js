/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {porterStem} from '../../src/evaluation/rouge/porter_stemmer.js';

// Expected values are the canonical Porter algorithm outputs (verified against
// the reference vocabulary at tartarus.org/martin/PorterStemmer). The words are
// chosen to exercise every step and branch of the algorithm.
const CASES: Array<[string, string]> = [
  // Short words are returned unchanged.
  ['a', 'a'],
  ['an', 'an'],
  ['by', 'by'],
  // Leading 'y' is treated as a consonant during stemming, then restored.
  ['yellow', 'yellow'],
  ['yearly', 'yearli'],
  // Step 1a.
  ['caresses', 'caress'],
  ['ponies', 'poni'],
  ['ties', 'ti'],
  ['caress', 'caress'],
  ['cats', 'cat'],
  // Step 1b.
  ['feed', 'feed'],
  ['agreed', 'agre'],
  ['plastered', 'plaster'],
  ['bled', 'bled'],
  ['motoring', 'motor'],
  ['sing', 'sing'],
  ['conflated', 'conflat'],
  ['troubled', 'troubl'],
  ['sized', 'size'],
  ['hopping', 'hop'],
  ['tanned', 'tan'],
  ['falling', 'fall'],
  ['hissing', 'hiss'],
  ['fizzed', 'fizz'],
  ['failing', 'fail'],
  ['filing', 'file'],
  // Step 1c.
  ['happy', 'happi'],
  ['sky', 'sky'],
  // Step 2.
  ['relational', 'relat'],
  ['conditional', 'condit'],
  ['rational', 'ration'],
  ['valenci', 'valenc'],
  ['hesitanci', 'hesit'],
  ['digitizer', 'digit'],
  ['conformabli', 'conform'],
  ['radicalli', 'radic'],
  ['differentli', 'differ'],
  ['vileli', 'vile'],
  ['analogousli', 'analog'],
  ['vietnamization', 'vietnam'],
  ['predication', 'predic'],
  ['operator', 'oper'],
  ['feudalism', 'feudal'],
  ['decisiveness', 'decis'],
  ['hopefulness', 'hope'],
  ['callousness', 'callous'],
  ['formaliti', 'formal'],
  ['sensitiviti', 'sensit'],
  ['sensibiliti', 'sensibl'],
  // Step 3.
  ['triplicate', 'triplic'],
  ['formative', 'form'],
  ['formalize', 'formal'],
  ['electriciti', 'electr'],
  ['electrical', 'electr'],
  ['hopeful', 'hope'],
  ['goodness', 'good'],
  // Step 4.
  ['revival', 'reviv'],
  ['allowance', 'allow'],
  ['inference', 'infer'],
  ['airliner', 'airlin'],
  ['gyroscopic', 'gyroscop'],
  ['adjustable', 'adjust'],
  ['defensible', 'defens'],
  ['irritant', 'irrit'],
  ['replacement', 'replac'],
  ['adjustment', 'adjust'],
  ['dependent', 'depend'],
  ['adoption', 'adopt'],
  ['homologou', 'homolog'],
  ['communism', 'commun'],
  ['activate', 'activ'],
  ['angulariti', 'angular'],
  ['homologous', 'homolog'],
  ['effective', 'effect'],
  ['bowdlerize', 'bowdler'],
  // Step 5.
  ['probate', 'probat'],
  ['rate', 'rate'],
  ['cease', 'ceas'],
  ['controll', 'control'],
  ['roll', 'roll'],
];

describe('evaluation/rouge/porter_stemmer', () => {
  it.each(CASES)('stems %s to %s', (word, expected) => {
    expect(porterStem(word)).toBe(expected);
  });
});
