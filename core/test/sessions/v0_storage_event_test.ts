/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports `tests/unittests/sessions/test_v0_storage_event.py` from
 * `google/adk-python`, read at `main`. The `it` names are the reference test
 * names, so the two suites can be diffed by name.
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {createEvent} from '../../src/events/event.js';
import {createEventActions} from '../../src/events/event_actions.js';
import {DEFAULT_MAX_VARCHAR_LENGTH} from '../../src/sessions/db/schema.js';
import {
  storageEventV0FromEvent,
  storageEventV0ToEvent,
  truncateStr,
} from '../../src/sessions/db/schema_v0.js';
import {createSession} from '../../src/sessions/session.js';
import {logger} from '../../src/utils/logger.js';

const SESSION = createSession({
  appName: 'app',
  userId: 'user',
  id: 'session_id',
});

describe('v0 StorageEvent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Replaces `test_storage_event_v0_to_event_rehydrates_compaction_model`.
   * adk-js's `EventActions` has no `compaction` field, so the nested model is
   * stood in for by a nested object in `stateDelta`, which travels the same
   * encode and decode path.
   */
  it('storage_event_v0_to_event_rehydrates_a_nested_model', () => {
    const event = createEvent({
      id: 'event_id',
      invocationId: 'invocation_id',
      author: 'author',
      timestamp: 3000,
      actions: createEventActions({
        stateDelta: {
          compaction: {
            start_timestamp: 1.0,
            end_timestamp: 2.0,
            compacted_content: {role: 'user', parts: [{text: 'compacted'}]},
          },
        },
      }),
    });

    const rehydrated = storageEventV0ToEvent(
      storageEventV0FromEvent(SESSION, event),
    );

    expect(rehydrated.actions.stateDelta['compaction']).toEqual({
      start_timestamp: 1.0,
      end_timestamp: 2.0,
      compacted_content: {role: 'user', parts: [{text: 'compacted'}]},
    });
  });

  it('truncate_str_returns_none_for_none', () => {
    expect(truncateStr(undefined, 256)).toBeUndefined();
  });

  it('truncate_str_returns_short_string_unchanged', () => {
    expect(truncateStr('short message', 256)).toBe('short message');
  });

  it('truncate_str_returns_exact_length_string_unchanged', () => {
    const exact = 'a'.repeat(DEFAULT_MAX_VARCHAR_LENGTH);

    expect(truncateStr(exact, DEFAULT_MAX_VARCHAR_LENGTH)).toBe(exact);
  });

  it('truncate_str_truncates_long_string', () => {
    const result = truncateStr('x'.repeat(1000), DEFAULT_MAX_VARCHAR_LENGTH);

    expect(result).toHaveLength(DEFAULT_MAX_VARCHAR_LENGTH);
    expect(result?.endsWith('...[truncated]')).toBe(true);
  });

  it('truncate_str_warns_once_naming_both_lengths', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    truncateStr('x'.repeat(1000), DEFAULT_MAX_VARCHAR_LENGTH);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('from 1000 to 256 characters');
  });

  it('truncate_str_stays_silent_when_the_value_fits', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    truncateStr('x'.repeat(DEFAULT_MAX_VARCHAR_LENGTH), 256);

    expect(warn).not.toHaveBeenCalled();
  });

  it('from_event_truncates_long_error_message', () => {
    const event = createEvent({
      id: 'event_id',
      invocationId: 'inv_id',
      author: 'agent',
      timestamp: 1000,
      errorCode: 'MALFORMED_FUNCTION_CALL',
      errorMessage: `Malformed function call: ${'a'.repeat(1000)}`,
    });
    vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const row = storageEventV0FromEvent(SESSION, event);

    expect(row.errorMessage).toHaveLength(DEFAULT_MAX_VARCHAR_LENGTH);
    expect(row.errorMessage?.endsWith('...[truncated]')).toBe(true);
    expect(row.errorCode).toBe('MALFORMED_FUNCTION_CALL');
  });

  it('from_event_preserves_short_error_message', () => {
    const event = createEvent({
      id: 'event_id',
      invocationId: 'inv_id',
      author: 'agent',
      timestamp: 1000,
      errorCode: 'SOME_ERROR',
      errorMessage: 'Something went wrong',
    });

    expect(storageEventV0FromEvent(SESSION, event).errorMessage).toBe(
      'Something went wrong',
    );
  });

  /**
   * Adapted: adk-js carries `Event.timestamp` in milliseconds, so the
   * reference's `1.0` second becomes `1000`, and the column holds
   * `new Date(1000)`.
   */
  it('storage_event_v0_timestamp_round_trip_uses_utc', () => {
    const event = createEvent({author: 'agent', timestamp: 1000});

    const row = storageEventV0FromEvent(SESSION, event);

    expect(row.timestamp).toEqual(new Date(1000));
    expect(row.timestamp.toISOString()).toBe('1970-01-01T00:00:01.000Z');
    expect(storageEventV0ToEvent(row).timestamp).toBe(1000);
  });
});
