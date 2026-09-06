/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {CompactedEvent, Event, createEventsCompactionConfig} from '@google/adk';
import {describe, expect, it} from 'vitest';

const TOKEN_TRIGGER = {tokenThreshold: 1000, eventRetentionSize: 5};
const WINDOW_TRIGGER = {compactionInterval: 2, overlapSize: 1};

describe('createEventsCompactionConfig', () => {
  it('accepts the sliding-window pair on its own', () => {
    expect(createEventsCompactionConfig(WINDOW_TRIGGER)).toEqual(
      WINDOW_TRIGGER,
    );
  });

  it('accepts the token-threshold pair on its own', () => {
    expect(createEventsCompactionConfig(TOKEN_TRIGGER)).toEqual(TOKEN_TRIGGER);
  });

  it('accepts both trigger pairs together', () => {
    expect(
      createEventsCompactionConfig({...TOKEN_TRIGGER, ...WINDOW_TRIGGER}),
    ).toEqual({...TOKEN_TRIGGER, ...WINDOW_TRIGGER});
  });

  it('keeps the summarizer it is given', () => {
    const summarizer = {
      summarize: async (events: Event[]): Promise<CompactedEvent> => {
        throw new Error(`unused, given ${events.length} events`);
      },
    };

    const config = createEventsCompactionConfig({
      ...WINDOW_TRIGGER,
      summarizer,
    });

    expect(config.summarizer).toBe(summarizer);
  });

  it('rejects a tokenThreshold without an eventRetentionSize', () => {
    expect(() =>
      createEventsCompactionConfig({tokenThreshold: 1000}),
    ).toThrowError(
      'tokenThreshold and eventRetentionSize must be set together.',
    );
  });

  it('rejects an eventRetentionSize without a tokenThreshold', () => {
    expect(() =>
      createEventsCompactionConfig({eventRetentionSize: 5}),
    ).toThrowError(
      'tokenThreshold and eventRetentionSize must be set together.',
    );
  });

  it('rejects a compactionInterval without an overlapSize', () => {
    expect(() =>
      createEventsCompactionConfig({compactionInterval: 2}),
    ).toThrowError('compactionInterval and overlapSize must be set together.');
  });

  it('rejects an overlapSize without a compactionInterval', () => {
    expect(() => createEventsCompactionConfig({overlapSize: 1})).toThrowError(
      'compactionInterval and overlapSize must be set together.',
    );
  });

  it('rejects a config with no trigger at all', () => {
    expect(() => createEventsCompactionConfig()).toThrowError(
      'At least one compaction trigger must be configured: the token-threshold' +
        ' pair or the sliding-window pair.',
    );
  });

  it('rejects a compactionInterval below 1', () => {
    expect(() =>
      createEventsCompactionConfig({...WINDOW_TRIGGER, compactionInterval: 0}),
    ).toThrowError('compactionInterval must be at least 1.');
  });

  it('rejects a negative overlapSize', () => {
    expect(() =>
      createEventsCompactionConfig({...WINDOW_TRIGGER, overlapSize: -1}),
    ).toThrowError('overlapSize must be at least 0.');
  });

  it('rejects a tokenThreshold below 1', () => {
    expect(() =>
      createEventsCompactionConfig({...TOKEN_TRIGGER, tokenThreshold: 0}),
    ).toThrowError('tokenThreshold must be at least 1.');
  });

  it('rejects a negative eventRetentionSize', () => {
    expect(() =>
      createEventsCompactionConfig({...TOKEN_TRIGGER, eventRetentionSize: -1}),
    ).toThrowError('eventRetentionSize must be at least 0.');
  });

  it('accepts the zero-valued ends of both inclusive bounds', () => {
    const config = createEventsCompactionConfig({
      compactionInterval: 1,
      overlapSize: 0,
      tokenThreshold: 1,
      eventRetentionSize: 0,
    });

    expect(config).toEqual({
      compactionInterval: 1,
      overlapSize: 0,
      tokenThreshold: 1,
      eventRetentionSize: 0,
    });
  });
});
