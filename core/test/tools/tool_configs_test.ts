/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError, toBaseToolParams} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('toBaseToolParams', () => {
  it('rejects a config without a name', () => {
    expect(() => toBaseToolParams({description: 'd'})).toThrow(
      new InputValidationError(
        'Invalid tool config: "name" must be a string, got undefined.',
      ),
    );
  });

  it('reports the type a non-string name actually holds', () => {
    expect(() => toBaseToolParams({name: 42, description: 'd'})).toThrow(
      new InputValidationError(
        'Invalid tool config: "name" must be a string, got number.',
      ),
    );
  });

  it('rejects an empty name', () => {
    expect(() => toBaseToolParams({name: '', description: 'd'})).toThrow(
      new InputValidationError(
        'Invalid tool config: "name" must not be empty.',
      ),
    );
  });

  it('rejects a config without a description', () => {
    expect(() => toBaseToolParams({name: 'a'})).toThrow(
      new InputValidationError(
        'Invalid tool config: "description" must be a string, got undefined.',
      ),
    );
  });

  it('rejects a non-string description', () => {
    expect(() => toBaseToolParams({name: 'a', description: true})).toThrow(
      new InputValidationError(
        'Invalid tool config: "description" must be a string, got boolean.',
      ),
    );
  });

  it('rejects a non-boolean isLongRunning', () => {
    expect(() =>
      toBaseToolParams({name: 'a', description: 'd', isLongRunning: 'true'}),
    ).toThrow(
      new InputValidationError(
        'Invalid tool config: "isLongRunning" must be a boolean, got string.',
      ),
    );
  });

  it('reports null as null rather than object', () => {
    expect(() => toBaseToolParams({name: null, description: 'd'})).toThrow(
      new InputValidationError(
        'Invalid tool config: "name" must be a string, got null.',
      ),
    );
  });

  it('reports an array as array rather than object', () => {
    expect(() => toBaseToolParams({name: ['a'], description: 'd'})).toThrow(
      new InputValidationError(
        'Invalid tool config: "name" must be a string, got array.',
      ),
    );
  });

  it('throws InputValidationError, not a bare Error', () => {
    expect(() => toBaseToolParams({description: 'd'})).toThrow(
      InputValidationError,
    );
  });

  it('accepts an absent isLongRunning', () => {
    expect(toBaseToolParams({name: 'a', description: 'd'})).toEqual({
      name: 'a',
      description: 'd',
      isLongRunning: undefined,
    });
  });

  it('forwards unknown keys unchanged', () => {
    expect(
      toBaseToolParams({
        name: 'a',
        description: 'd',
        isLongRunning: true,
        myOption: {nested: 1},
      }),
    ).toEqual({
      name: 'a',
      description: 'd',
      isLongRunning: true,
      myOption: {nested: 1},
    });
  });

  it('keeps a rejected value out of the message', () => {
    expect(() =>
      toBaseToolParams({
        name: 'a',
        description: 'd',
        isLongRunning: 'sk-secret',
      }),
    ).toThrow(
      new InputValidationError(
        'Invalid tool config: "isLongRunning" must be a boolean, got string.',
      ),
    );
  });
});
