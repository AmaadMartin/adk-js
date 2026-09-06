/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createMemoryEntry} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';

const content: Content = {role: 'user', parts: [{text: 'user likes blue'}]};

describe('createMemoryEntry', () => {
  it('defaults customMetadata to an empty object', () => {
    const entry = createMemoryEntry({content});

    expect(entry.customMetadata).toEqual({});
    expect(entry.id).toBeUndefined();
    expect(entry.author).toBeUndefined();
    expect(entry.timestamp).toBeUndefined();
  });

  it('keeps a supplied customMetadata verbatim', () => {
    const entry = createMemoryEntry({
      content,
      customMetadata: {source: 'onboarding-form'},
    });

    expect(entry.customMetadata).toEqual({source: 'onboarding-form'});
  });

  it('does not share one metadata object between two entries', () => {
    const first = createMemoryEntry({content});
    const second = createMemoryEntry({content});

    expect(first.customMetadata).toEqual({});
    expect(second.customMetadata).not.toBe(first.customMetadata);
  });

  it('keeps an explicitly supplied empty customMetadata', () => {
    const supplied = {};
    const entry = createMemoryEntry({content, customMetadata: supplied});

    expect(entry.customMetadata).toBe(supplied);
  });

  it('round-trips id, author and timestamp', () => {
    const entry = createMemoryEntry({
      content,
      id: 'mem-123',
      author: 'user',
      timestamp: '2026-04-21T12:00:00Z',
    });

    expect(entry).toEqual({
      content,
      customMetadata: {},
      id: 'mem-123',
      author: 'user',
      timestamp: '2026-04-21T12:00:00Z',
    });
  });
});
