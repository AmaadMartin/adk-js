/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  Example,
  isExample,
  isExampleArray,
} from '../../src/examples/example.js';

const SIMPLE_EXAMPLE: Example = {
  input: {parts: [{text: 'What is 2+2?'}]},
  output: [{role: 'model', parts: [{text: '4'}]}],
};

describe('isExample', () => {
  it('accepts a value carrying an input object and an output list', () => {
    expect(isExample(SIMPLE_EXAMPLE)).toBe(true);
  });

  it.each([
    ['a number', 42],
    ['null', null],
    ['a string', 'not an example'],
    ['an object with no input', {output: []}],
    ['an object whose input is not an object', {input: 'hi', output: []}],
    ['an object whose input is null', {input: null, output: []}],
    ['an object with no output', {input: {}}],
    ['an object whose output is not a list', {input: {}, output: 'no'}],
  ])('rejects %s', (_label, value) => {
    expect(isExample(value)).toBe(false);
  });
});

describe('isExampleArray', () => {
  it('accepts a list of examples', () => {
    expect(isExampleArray([SIMPLE_EXAMPLE])).toBe(true);
  });

  it('accepts an empty list', () => {
    expect(isExampleArray([])).toBe(true);
  });

  it('rejects a value that is not a list', () => {
    expect(isExampleArray(SIMPLE_EXAMPLE)).toBe(false);
  });

  it('rejects a list holding one malformed element', () => {
    expect(isExampleArray([SIMPLE_EXAMPLE, {nope: 1}])).toBe(false);
  });
});
