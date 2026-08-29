/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {EvalTurn} from '../../src/evaluation/eval_types.js';
import {
  evaluateResponses,
  rouge1FMeasure,
  tokenize,
} from '../../src/evaluation/response_evaluator.js';

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function printedOutput(): string {
  return logSpy.mock.calls.map((call) => String(call[0])).join('\n');
}

/** A turn carrying only what the response metric reads. */
function turn(response?: string, reference?: string | null): EvalTurn {
  return {query: 'a query', response, reference};
}

describe('tokenize', () => {
  it('lowercases and splits on runs of non-alphanumeric characters', () => {
    expect(tokenize('Hello,   WORLD!! 42')).toEqual(['hello', 'world', '42']);
  });

  it('drops leading and trailing separators rather than emitting blanks', () => {
    expect(tokenize('  ...hi...  ')).toEqual(['hi']);
  });

  it('yields no token for text with no alphanumeric character', () => {
    expect(tokenize('--- !!! ---')).toEqual([]);
  });

  it('splits on a non-ASCII letter, as the ROUGE tokenizer does', () => {
    // `rouge_score` replaces everything outside [a-z0-9] with a space after
    // lowercasing, so an accented letter is a separator there and here.
    expect(tokenize('café')).toEqual(['caf']);
  });
});

describe('rouge1FMeasure', () => {
  it('scores identical text 1', () => {
    expect(rouge1FMeasure('the cat sat', 'the cat sat')).toBe(1);
  });

  it('ignores case and punctuation', () => {
    expect(rouge1FMeasure('Hello, WORLD!', 'hello world')).toBe(1);
  });

  it('scores text sharing no word 0', () => {
    expect(rouge1FMeasure('alpha beta', 'gamma delta')).toBe(0);
  });

  it('ignores word order', () => {
    expect(rouge1FMeasure('cat the sat', 'the cat sat')).toBe(1);
  });

  it('scores a partial overlap by F-measure', () => {
    // response: the(2) cat sat on mat -> 6 tokens.
    // reference: the(2) cat is on mat -> 6 tokens.
    // overlap 5 => precision 5/6, recall 5/6, F = 5/6.
    expect(rouge1FMeasure('the cat sat on the mat', 'the cat is on the mat')) //
      .toBeCloseTo(5 / 6, 10);
  });

  it('clips a repeated word to the count in the reference', () => {
    // overlap = min(1, 3) = 1 => precision 1/3, recall 1, F = 0.5.
    // Counting every response occurrence would give 1.5.
    expect(rouge1FMeasure('yes yes yes', 'yes')).toBe(0.5);
  });

  it('scores an empty response 0', () => {
    expect(rouge1FMeasure('', 'the cat sat')).toBe(0);
  });

  it('scores an empty reference 0', () => {
    expect(rouge1FMeasure('the cat sat', '')).toBe(0);
  });

  it('scores two empty strings 0 rather than NaN', () => {
    expect(rouge1FMeasure('', '')).toBe(0);
  });
});

describe('evaluateResponses', () => {
  it('throws when the dataset holds no conversation', () => {
    expect(() => evaluateResponses([])).toThrow(
      'The evaluation dataset is empty.',
    );
  });

  it('returns undefined when no turn recorded a reference', () => {
    expect(evaluateResponses([[turn('an answer')]])).toBeUndefined();
  });

  it('returns undefined when every reference is null', () => {
    expect(evaluateResponses([[turn('an answer', null)]])).toBeUndefined();
  });

  it('returns undefined for a conversation with no turns', () => {
    expect(evaluateResponses([[]])).toBeUndefined();
  });

  it('scores one turn against its reference', () => {
    expect(evaluateResponses([[turn('the cat sat', 'the cat sat')]])).toBe(1);
  });

  it('averages over the turns of a conversation', () => {
    const score = evaluateResponses([
      [turn('the cat sat', 'the cat sat'), turn('alpha', 'omega')],
    ]);

    expect(score).toBe(0.5);
  });

  it('averages over every conversation in the dataset', () => {
    const score = evaluateResponses([
      [turn('the cat sat', 'the cat sat')],
      [turn('alpha', 'omega')],
    ]);

    expect(score).toBe(0.5);
  });

  it('leaves a turn with no reference out of the mean', () => {
    const score = evaluateResponses([
      [turn('the cat sat', 'the cat sat'), turn('alpha')],
    ]);

    expect(score).toBe(1);
  });

  it('scores a turn that recorded no response 0', () => {
    expect(evaluateResponses([[turn(undefined, 'the cat sat')]])).toBe(0);
  });

  it('prints nothing without printDetailedResults', () => {
    evaluateResponses([[turn('the cat sat', 'the cat sat')]]);

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('prints a per-turn table with printDetailedResults', () => {
    evaluateResponses([[turn('the cat sat', 'the cat naps')]], {
      printDetailedResults: true,
    });

    const output = printedOutput();
    expect(output).toContain('query');
    expect(output).toContain('rouge_1');
    expect(output).toContain('the cat sat');
    expect(output).toContain('the cat naps');
    expect(output).toContain('0.67');
  });

  it('prints no table when no turn recorded a reference', () => {
    evaluateResponses([[turn('an answer')]], {printDetailedResults: true});

    expect(logSpy).not.toHaveBeenCalled();
  });
});
