/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {newUuid, resetIdProvider, setIdProvider} from '@google/adk';
import {afterEach, describe, expect, it} from 'vitest';

/** RFC 4122 version 4 UUID, as produced by the default provider. */
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuid', () => {
  afterEach(() => {
    resetIdProvider();
  });

  it('returns a v4 UUID from the default provider', () => {
    expect(newUuid()).toMatch(UUID_V4);
  });

  it('returns a different value on each default call', () => {
    expect(newUuid()).not.toBe(newUuid());
  });

  it('returns the value of a custom provider verbatim', () => {
    setIdProvider(() => 'custom-id');

    expect(newUuid()).toBe('custom-id');
  });

  it('restores the default provider on reset', () => {
    setIdProvider(() => 'custom-id');
    resetIdProvider();

    const id = newUuid();
    expect(id).not.toBe('custom-id');
    expect(id).toMatch(UUID_V4);
  });

  it('reset is safe when no provider was installed', () => {
    resetIdProvider();

    expect(newUuid()).toMatch(UUID_V4);
  });

  it('calls the provider on every read', () => {
    let calls = 0;
    setIdProvider(() => String(++calls));

    expect([newUuid(), newUuid(), newUuid()]).toEqual(['1', '2', '3']);
  });

  it('propagates an error thrown by the provider', () => {
    setIdProvider(() => {
      throw new Error('no id source');
    });

    expect(() => newUuid()).toThrow('no id source');
  });
});
