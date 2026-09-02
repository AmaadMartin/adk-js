/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  ReadonlyState,
  ReadonlyStateError,
  isReadonlyStateError,
} from '../../src/sessions/readonly_state.js';

describe('ReadonlyState', () => {
  describe('reads', () => {
    it('returns a value held by the underlying record', () => {
      const view = new ReadonlyState({key: 'value'});

      expect(view.get('key')).toBe('value');
    });

    it('returns the supplied default for a missing key', () => {
      const view = new ReadonlyState({});

      expect(view.get('missing', 'fallback')).toBe('fallback');
    });

    it('returns undefined for a missing key with no default', () => {
      const view = new ReadonlyState({});

      expect(view.get('missing')).toBeUndefined();
    });

    it('reports a present key as held and a missing one as absent', () => {
      const view = new ReadonlyState({key: 'value'});

      expect(view.has('key')).toBe(true);
      expect(view.has('missing')).toBe(false);
    });

    it('returns the underlying entries as a record', () => {
      const view = new ReadonlyState({key1: 'value1', key2: 'value2'});

      expect(view.toRecord()).toEqual({key1: 'value1', key2: 'value2'});
    });

    it('reads through to a write made after the view was taken', () => {
      const record: Record<string, unknown> = {key: 'value'};
      const view = new ReadonlyState(record);

      record['key'] = 'newValue';
      record['late'] = 'lateValue';

      expect(view.get('key')).toBe('newValue');
      expect(view.has('late')).toBe(true);
      expect(view.toRecord()).toEqual({key: 'newValue', late: 'lateValue'});
    });

    it('returns a nested object by reference, so the view is shallow', () => {
      const nested = {inner: 'value'};
      const view = new ReadonlyState({nested});

      expect(view.get('nested')).toBe(nested);
    });
  });

  describe('writes', () => {
    it('rejects set with a ReadonlyStateError naming the key', () => {
      const record: Record<string, unknown> = {key: 'value'};
      const view = new ReadonlyState(record);

      expect(() => view.set('key', 'newValue')).toThrow(ReadonlyStateError);
      expect(() => view.set('key', 'newValue')).toThrow(/'key'/);
      expect(record['key']).toBe('value');
    });

    it('leaves the record untouched when set is rejected', () => {
      const record: Record<string, unknown> = {};
      const view = new ReadonlyState(record);

      expect(() => view.set('added', 'value')).toThrow(ReadonlyStateError);
      expect(record).toEqual({});
      expect(view.has('added')).toBe(false);
    });

    it('rejects update with a ReadonlyStateError naming the keys', () => {
      const record: Record<string, unknown> = {key: 'value'};
      const view = new ReadonlyState(record);

      expect(() => view.update({a: 1, b: 2})).toThrow(ReadonlyStateError);
      expect(() => view.update({a: 1, b: 2})).toThrow(/"a","b"/);
      expect(record).toEqual({key: 'value'});
    });

    it('raises a TypeError, matching the Python read-only mapping', () => {
      const view = new ReadonlyState({});

      expect(() => view.set('key', 'value')).toThrow(TypeError);
      expect(() => view.update({key: 'value'})).toThrow(TypeError);
    });

    it('points a rejected write at the writer that is allowed', () => {
      const view = new ReadonlyState({});

      expect(() => view.set('key', 'value')).toThrow(/through a Context/);
    });
  });

  describe('isReadonlyStateError', () => {
    it('accepts an error thrown by a rejected write', () => {
      const view = new ReadonlyState({});
      let thrown: unknown;

      try {
        view.set('key', 'value');
      } catch (e: unknown) {
        thrown = e;
      }

      expect(isReadonlyStateError(thrown)).toBe(true);
    });

    it('rejects a plain TypeError and a non-error value', () => {
      expect(isReadonlyStateError(new TypeError('nope'))).toBe(false);
      expect(isReadonlyStateError('nope')).toBe(false);
      expect(isReadonlyStateError(undefined)).toBe(false);
    });
  });
});
