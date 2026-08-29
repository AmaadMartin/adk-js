/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {EvalTurn} from '../../src/evaluation/eval_types.js';
import {
  evaluateResponseMatch,
  rouge1FMeasure,
} from '../../src/evaluation/response_evaluator.js';

describe('rouge1FMeasure', () => {
  it('scores identical text 1', () => {
    expect(rouge1FMeasure('the cat sat', 'the cat sat')).toBe(1);
  });

  it('scores text that shares no word 0', () => {
    expect(rouge1FMeasure('the cat sat', 'a dog ran')).toBe(0);
  });

  it('balances precision against recall on a partial overlap', () => {
    // Overlap 2, precision 2/2, recall 2/6, so F = 2*1*(1/3)/(1+1/3) = 0.5.
    expect(rouge1FMeasure('the cat', 'the cat sat on the mat')).toBeCloseTo(
      0.5,
    );
  });

  it('ignores case and punctuation', () => {
    expect(rouge1FMeasure('The CAT, sat!', 'the cat sat')).toBe(1);
  });

  it('counts a repeated word only as often as the rarer side has it', () => {
    // Overlap 1, precision 1/3, recall 1/1, so F = 2*(1/3)*1/(1/3+1) = 0.5.
    expect(rouge1FMeasure('cat cat cat', 'cat')).toBeCloseTo(0.5);
  });

  it('scores an empty candidate 0 rather than NaN', () => {
    expect(rouge1FMeasure('', 'the cat sat')).toBe(0);
  });

  it('scores an empty reference 0 rather than NaN', () => {
    expect(rouge1FMeasure('the cat sat', '')).toBe(0);
  });

  it('scores two empty strings 0 rather than NaN', () => {
    expect(rouge1FMeasure('', '')).toBe(0);
  });

  it('scores text that is only punctuation 0 rather than NaN', () => {
    expect(rouge1FMeasure('!!! ...', 'the cat sat')).toBe(0);
  });

  it('ignores word order', () => {
    expect(rouge1FMeasure('sat cat the', 'the cat sat')).toBe(1);
  });

  it('keeps digits as tokens', () => {
    expect(rouge1FMeasure('rolled a 6', 'rolled a 6')).toBe(1);
    expect(rouge1FMeasure('rolled a 6', 'rolled a 20')).toBeCloseTo(2 / 3);
  });
});

describe('evaluateResponseMatch', () => {
  function turn(overrides: Partial<EvalTurn>): EvalTurn {
    return {query: 'roll a die', ...overrides};
  }

  it('returns undefined when no turn carries a reference', () => {
    expect(
      evaluateResponseMatch([
        turn({response: 'I rolled a 4.'}),
        turn({response: 'I rolled a 5.'}),
      ]),
    ).toBeUndefined();
  });

  it('returns undefined for an empty turn list', () => {
    expect(evaluateResponseMatch([])).toBeUndefined();
  });

  it('scores a single matching turn 1', () => {
    expect(
      evaluateResponseMatch([
        turn({response: 'I rolled a 4.', reference: 'I rolled a 4.'}),
      ]),
    ).toBe(1);
  });

  it('averages over the turns that carry a reference', () => {
    expect(
      evaluateResponseMatch([
        turn({response: 'I rolled a 4.', reference: 'I rolled a 4.'}),
        turn({response: 'nothing alike', reference: 'totally different'}),
      ]),
    ).toBeCloseTo(0.5);
  });

  it('skips a turn without a reference instead of scoring it 0', () => {
    expect(
      evaluateResponseMatch([
        turn({response: 'I rolled a 4.', reference: 'I rolled a 4.'}),
        turn({response: 'anything at all'}),
      ]),
    ).toBe(1);
  });

  it('skips a turn whose reference is null', () => {
    expect(
      evaluateResponseMatch([
        turn({response: 'I rolled a 4.', reference: 'I rolled a 4.'}),
        turn({response: 'anything at all', reference: null}),
      ]),
    ).toBe(1);
  });

  it('skips a turn whose reference is the empty string', () => {
    expect(
      evaluateResponseMatch([
        turn({response: 'I rolled a 4.', reference: 'I rolled a 4.'}),
        turn({response: 'anything at all', reference: ''}),
      ]),
    ).toBe(1);
  });

  it('scores a turn that produced no response 0 against its reference', () => {
    expect(evaluateResponseMatch([turn({reference: 'I rolled a 4.'})])).toBe(0);
  });
});
