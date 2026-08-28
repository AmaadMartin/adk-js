/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {EvalTurn} from '../../src/evaluation/eval_types.js';
import {
  evaluateResponseMatch,
  rougeOneFMeasure,
  tokenize,
} from '../../src/evaluation/response_evaluator.js';

/** Builds a turn carrying only the fields this metric reads. */
function turn(overrides: Partial<EvalTurn>): EvalTurn {
  return {query: 'q', ...overrides};
}

describe('tokenize', () => {
  it('lowercases and splits on whitespace', () => {
    expect(tokenize('The Cat SAT')).toEqual(['the', 'cat', 'sat']);
  });

  it('treats punctuation as a separator', () => {
    expect(tokenize('hello, world! (again)')).toEqual([
      'hello',
      'world',
      'again',
    ]);
  });

  it('keeps digits', () => {
    expect(tokenize('rolled a 16-sided die')).toEqual([
      'rolled',
      'a',
      '16',
      'sided',
      'die',
    ]);
  });

  it('drops leading and trailing separators', () => {
    expect(tokenize('  ...hi...  ')).toEqual(['hi']);
  });

  it('treats a non-ASCII letter as a separator', () => {
    expect(tokenize('café')).toEqual(['caf']);
  });

  it('returns nothing for text with no alphanumerics', () => {
    expect(tokenize('!!! ???')).toEqual([]);
  });
});

describe('rougeOneFMeasure', () => {
  it('scores identical text 1', () => {
    expect(rougeOneFMeasure('the cat sat', 'the cat sat')).toBe(1);
  });

  it('scores text sharing no word 0', () => {
    expect(rougeOneFMeasure('foo bar', 'baz qux')).toBe(0);
  });

  it('scores one differing word out of six', () => {
    expect(
      rougeOneFMeasure('the cat sat on the mat', 'the cat is on the mat'),
    ).toBeCloseTo(5 / 6, 10);
  });

  it('ignores case and punctuation', () => {
    expect(rougeOneFMeasure('Hello, world!', 'hello world')).toBe(1);
  });

  it('counts a repeated word only as often as the reference repeats it', () => {
    expect(rougeOneFMeasure('a a a', 'a')).toBeCloseTo(0.5, 10);
  });

  it('scores an empty candidate 0', () => {
    expect(rougeOneFMeasure('', 'the cat sat')).toBe(0);
  });

  it('scores an empty reference 0', () => {
    expect(rougeOneFMeasure('the cat sat', '')).toBe(0);
  });

  it('is symmetric, because precision and recall swap', () => {
    expect(rougeOneFMeasure('a b c', 'a b')).toBe(
      rougeOneFMeasure('a b', 'a b c'),
    );
  });
});

describe('evaluateResponseMatch', () => {
  it('scores a turn whose response matches its reference', () => {
    const score = evaluateResponseMatch([
      [turn({reference: 'I rolled a 4.', response: 'I rolled a 4.'})],
    ]);

    expect(score).toBe(1);
  });

  it('averages over every scored turn of every conversation', () => {
    const score = evaluateResponseMatch([
      [turn({reference: 'a b', response: 'a b'})],
      [turn({reference: 'a b', response: 'c d'})],
    ]);

    expect(score).toBe(0.5);
  });

  it('scores a turn that produced no response 0', () => {
    const score = evaluateResponseMatch([[turn({reference: 'a b'})]]);

    expect(score).toBe(0);
  });

  it('skips a turn that records no reference', () => {
    const score = evaluateResponseMatch([
      [
        turn({reference: 'a b', response: 'a b'}),
        turn({response: 'anything at all'}),
      ],
    ]);

    expect(score).toBe(1);
  });

  it('skips a turn whose reference is null', () => {
    const score = evaluateResponseMatch([
      [
        turn({reference: 'a b', response: 'a b'}),
        turn({reference: null, response: 'anything at all'}),
      ],
    ]);

    expect(score).toBe(1);
  });

  it('scores a turn whose reference is empty 0', () => {
    const score = evaluateResponseMatch([
      [turn({reference: '', response: 'a b'})],
    ]);

    expect(score).toBe(0);
  });

  it('does not apply when no turn records a reference', () => {
    const score = evaluateResponseMatch([[turn({response: 'a b'})]]);

    expect(score).toBeUndefined();
  });

  it('does not apply to an empty dataset', () => {
    expect(evaluateResponseMatch([])).toBeUndefined();
  });

  it('does not apply to a conversation with no turns', () => {
    expect(evaluateResponseMatch([[]])).toBeUndefined();
  });
});
