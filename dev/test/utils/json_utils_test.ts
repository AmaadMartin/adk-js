/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  isRecord,
  parseJsonObject,
  parseStateOption,
} from '../../src/utils/json_utils.js';

describe('isRecord', () => {
  it.each([
    [{}, true],
    [{a: 1}, true],
    [[], false],
    [null, false],
    ['text', false],
    [7, false],
    [undefined, false],
  ])('reports %o as %s', (value, expected) => {
    expect(isRecord(value)).toBe(expected);
  });
});

describe('parseJsonObject', () => {
  it('parses an object', () => {
    expect(parseJsonObject('{"tier":"gold","seats":2}')).toEqual({
      tier: 'gold',
      seats: 2,
    });
  });

  it('rejects text that is not JSON', () => {
    expect(() => parseJsonObject('{tier: gold}')).toThrow(SyntaxError);
  });

  it.each(['[1,2]', '"gold"', '7', 'null'])(
    'rejects the non-object JSON %s',
    (value) => {
      expect(() => parseJsonObject(value)).toThrow('expected a JSON object');
    },
  );
});

describe('parseStateOption', () => {
  it('parses the option', () => {
    expect(parseStateOption('{"tier":"gold"}')).toEqual({tier: 'gold'});
  });

  it.each([undefined, ''])('reads %o as no state at all', (value) => {
    expect(parseStateOption(value)).toBeUndefined();
  });

  it('names the option in the error', () => {
    expect(() => parseStateOption('{tier: gold}')).toThrow(
      /^Invalid JSON for --state: /,
    );
  });

  it('names the option when the JSON is not an object', () => {
    expect(() => parseStateOption('"gold"')).toThrow(
      'Invalid JSON for --state: expected a JSON object, got string',
    );
  });
});
