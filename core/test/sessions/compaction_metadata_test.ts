/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createCompactedEvent} from '@google/adk/events/compacted_event.js';
import {
  parseCompactionMetadata,
  toAliasedCompactionMetadata,
  toCompactionMetadata,
} from '@google/adk/sessions/compaction_metadata.js';
import {describe, expect, it} from 'vitest';

/**
 * The fixtures mirror `test_append_event_with_compaction` in adk-python's
 * `tests/unittests/sessions/test_vertex_ai_session_service.py`, which is the
 * ground truth for the payload both SDKs must agree on.
 */
const START_TIMESTAMP = 1000;
const END_TIMESTAMP = 2000;
const SUMMARY = 'compacted summary';
const SUMMARY_CONTENT = {role: 'model', parts: [{text: SUMMARY}]};

describe('toCompactionMetadata', () => {
  it('emits only the snake_case keys adk-python persists', () => {
    const event = createCompactedEvent({
      startTime: START_TIMESTAMP,
      endTime: END_TIMESTAMP,
      compactedContent: SUMMARY,
      content: SUMMARY_CONTENT,
    });

    expect(toCompactionMetadata(event)).toEqual({
      start_timestamp: START_TIMESTAMP,
      end_timestamp: END_TIMESTAMP,
      compacted_content: SUMMARY_CONTENT,
    });
  });

  it('keeps a multi-part content instead of flattening it', () => {
    const content = {
      role: 'model',
      parts: [{text: 'first '}, {text: 'second'}],
    };
    const event = createCompactedEvent({
      startTime: START_TIMESTAMP,
      endTime: END_TIMESTAMP,
      compactedContent: 'first second',
      content,
    });

    expect(toCompactionMetadata(event).compacted_content).toEqual(content);
  });

  it('synthesizes a model content when the event has none', () => {
    const event = createCompactedEvent({
      startTime: START_TIMESTAMP,
      endTime: END_TIMESTAMP,
      compactedContent: SUMMARY,
    });

    expect(toCompactionMetadata(event).compacted_content).toEqual(
      SUMMARY_CONTENT,
    );
  });
});

describe('toAliasedCompactionMetadata', () => {
  it('emits only the camelCase alias keys adk-python mirrors into rawEvent', () => {
    const event = createCompactedEvent({
      startTime: START_TIMESTAMP,
      endTime: END_TIMESTAMP,
      compactedContent: SUMMARY,
      content: SUMMARY_CONTENT,
    });

    expect(toAliasedCompactionMetadata(event)).toEqual({
      startTimestamp: START_TIMESTAMP,
      endTimestamp: END_TIMESTAMP,
      compactedContent: SUMMARY_CONTENT,
    });
  });
});

describe('parseCompactionMetadata', () => {
  it('accepts the canonical snake_case payload', () => {
    expect(
      parseCompactionMetadata({
        start_timestamp: START_TIMESTAMP,
        end_timestamp: END_TIMESTAMP,
        compacted_content: SUMMARY_CONTENT,
      }),
    ).toEqual({
      startTime: START_TIMESTAMP,
      endTime: END_TIMESTAMP,
      compactedContent: SUMMARY,
      content: SUMMARY_CONTENT,
    });
  });

  it('accepts the camelCase alias payload', () => {
    expect(
      parseCompactionMetadata({
        startTimestamp: START_TIMESTAMP,
        endTimestamp: END_TIMESTAMP,
        compactedContent: SUMMARY_CONTENT,
      }),
    ).toEqual({
      startTime: START_TIMESTAMP,
      endTime: END_TIMESTAMP,
      compactedContent: SUMMARY,
      content: SUMMARY_CONTENT,
    });
  });

  it('accepts the historical adk-js payload with a string summary', () => {
    expect(
      parseCompactionMetadata({
        startTime: START_TIMESTAMP,
        endTime: END_TIMESTAMP,
        compactedContent: SUMMARY,
      }),
    ).toEqual({
      startTime: START_TIMESTAMP,
      endTime: END_TIMESTAMP,
      compactedContent: SUMMARY,
    });
  });

  it('joins the text parts and skips the parts that carry none', () => {
    const parsed = parseCompactionMetadata({
      start_timestamp: START_TIMESTAMP,
      end_timestamp: END_TIMESTAMP,
      compacted_content: {
        role: 'model',
        parts: [
          {text: 'first '},
          {inlineData: {mimeType: 'image/png', data: 'AAAA'}},
          {text: 'second'},
        ],
      },
    });

    expect(parsed?.compactedContent).toBe('first second');
  });

  it('reads a content with no parts as an empty summary', () => {
    const parsed = parseCompactionMetadata({
      start_timestamp: START_TIMESTAMP,
      end_timestamp: END_TIMESTAMP,
      compacted_content: {role: 'model'},
    });

    expect(parsed?.compactedContent).toBe('');
  });

  it.each([
    ['an empty object', {}],
    ['null', null],
    ['a string', 'nope'],
    ['a number', 42],
    ['an array', []],
    [
      'a snake_case payload with a string summary',
      {
        start_timestamp: START_TIMESTAMP,
        end_timestamp: END_TIMESTAMP,
        compacted_content: SUMMARY,
      },
    ],
    [
      'an alias payload with a string summary',
      {
        startTimestamp: START_TIMESTAMP,
        endTimestamp: END_TIMESTAMP,
        compactedContent: SUMMARY,
      },
    ],
    [
      'a legacy payload with a content summary',
      {
        startTime: START_TIMESTAMP,
        endTime: END_TIMESTAMP,
        compactedContent: SUMMARY_CONTENT,
      },
    ],
    [
      'a payload with string timestamps',
      {
        start_timestamp: '1000',
        end_timestamp: '2000',
        compacted_content: SUMMARY_CONTENT,
      },
    ],
    [
      'a payload missing the end timestamp',
      {start_timestamp: START_TIMESTAMP, compacted_content: SUMMARY_CONTENT},
    ],
    [
      'a payload whose parts are not an array',
      {
        start_timestamp: START_TIMESTAMP,
        end_timestamp: END_TIMESTAMP,
        compacted_content: {parts: 'summary'},
      },
    ],
  ])('returns undefined for %s', (_description, payload) => {
    expect(parseCompactionMetadata(payload)).toBeUndefined();
  });
});
