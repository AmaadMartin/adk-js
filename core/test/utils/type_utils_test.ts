/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {isRecord} from '../../src/utils/type_utils.js';

class Widget {
  readonly kind = 'widget';
}

describe('isRecord', () => {
  it('accepts an object literal', () => {
    expect(isRecord({a: 1})).toBe(true);
  });

  it('accepts a class instance', () => {
    expect(isRecord(new Widget())).toBe(true);
  });

  it('rejects null', () => {
    expect(isRecord(null)).toBe(false);
  });

  it('rejects an array', () => {
    expect(isRecord([1, 2])).toBe(false);
  });

  it('rejects a string', () => {
    expect(isRecord('ui://demo')).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isRecord(undefined)).toBe(false);
  });

  it('narrows the value so its fields are readable', () => {
    const value: unknown = {resourceUri: 'ui://demo/card'};
    if (!isRecord(value)) {
      expect.fail('expected a record');
    }
    expect(value['resourceUri']).toBe('ui://demo/card');
  });
});
