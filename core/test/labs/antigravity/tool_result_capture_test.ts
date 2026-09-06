/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the tool-result buffer and its two hooks.
 *
 * Ported from adk-python
 * `tests/unittests/labs/antigravity/test_tool_result_capture.py` at
 * `a119dd77`. The `it(...)` names are the reference test names, verbatim.
 */

import {AntigravityToolResult} from '@google/adk';
import {
  createToolErrorCapture,
  createToolResultCapture,
  ToolResultBuffer,
} from '@google/adk/labs/antigravity/tool_result_capture.js';
import {describe, expect, it} from 'vitest';

/** An Antigravity tool result as the post-tool-call hook receives one. */
function result(
  callId: string | undefined,
  value?: unknown,
  name = 'reviewer',
): AntigravityToolResult {
  return {name, id: callId, result: value};
}

/**
 * Stands in for the SDK's `ToolExecutionError`.
 *
 * Structural rather than the SDK class, for the same reason the capture reads
 * a shape rather than a class: no Antigravity SDK is published for JavaScript.
 */
class ToolFailure extends Error {
  constructor(
    message: string,
    readonly toolName: string,
    readonly callId?: string,
  ) {
    super(message);
  }
}

/** The error the on-tool-error hook would receive. */
function failure(
  callId: string | undefined,
  message = 'child agent exploded',
  name = 'reviewer',
): ToolFailure {
  return new ToolFailure(message, name, callId);
}

describe('ToolResultBuffer', () => {
  it('test_a_result_is_buffered_under_its_call_id', async () => {
    const buffer = new ToolResultBuffer();
    const capture = createToolResultCapture(buffer);
    const recorded = result('call_3', '{"result": "good name"}');

    await capture.run(recorded);

    expect(buffer.take(new Set(['call_3']))).toEqual([['call_3', recorded]]);
  });

  it('test_a_result_without_an_id_is_dropped', async () => {
    const buffer = new ToolResultBuffer();
    const capture = createToolResultCapture(buffer);

    await capture.run(result(undefined, 'orphan'));

    expect(buffer.size).toBe(0);
  });

  it('test_take_returns_only_the_requested_ids_and_removes_them', () => {
    const buffer = new ToolResultBuffer();
    const first = result('c1', 'a');
    const second = result('c2', 'b');
    buffer.record(first);
    buffer.record(second);

    expect(buffer.take(new Set(['c1']))).toEqual([['c1', first]]);
    expect(buffer.take(new Set(['c1']))).toEqual([]);
    expect(buffer.take(new Set(['c1', 'c2']))).toEqual([['c2', second]]);
  });

  it('test_take_preserves_arrival_order', () => {
    const buffer = new ToolResultBuffer();
    buffer.record(result('c2', 'second'));
    buffer.record(result('c1', 'first'));

    expect(
      buffer.take(new Set(['c1', 'c2'])).map(([callId]) => callId),
    ).toEqual(['c2', 'c1']);
  });

  it('test_a_failure_is_buffered_under_its_call_id', async () => {
    const buffer = new ToolResultBuffer();
    const capture = createToolErrorCapture(buffer);

    await capture.run(failure('call_3'));

    const [entry] = buffer.take(new Set(['call_3']));
    expect(entry).toBeDefined();
    const [callId, recorded] = entry;
    expect(callId).toBe('call_3');
    expect(recorded.name).toBe('reviewer');
    expect(recorded.error).toBe('child agent exploded');
    expect(recorded.result).toBeNull();
  });

  it('test_a_failure_without_a_call_id_is_dropped', async () => {
    const buffer = new ToolResultBuffer();
    const capture = createToolErrorCapture(buffer);

    await capture.run(failure(undefined));

    expect(buffer.size).toBe(0);
  });

  it('test_the_error_hook_returns_none_so_the_harness_message_stands', async () => {
    const buffer = new ToolResultBuffer();
    const capture = createToolErrorCapture(buffer);

    await expect(capture.run(failure('call_3'))).resolves.toBeUndefined();
  });

  it('test_both_hooks_feed_one_buffer', async () => {
    const buffer = new ToolResultBuffer();
    const results = createToolResultCapture(buffer);
    const errors = createToolErrorCapture(buffer);

    await results.run(result('c1', 'ok'));
    await errors.run(failure('c2'));

    expect(
      buffer.take(new Set(['c1', 'c2'])).map(([callId]) => callId),
    ).toEqual(['c1', 'c2']);
  });

  it('test_clear_empties_the_buffer', () => {
    const buffer = new ToolResultBuffer();
    buffer.record(result('c1', 'a'));

    buffer.clear();

    expect(buffer.size).toBe(0);
  });

  it('test_a_later_result_for_one_call_id_replaces_the_earlier', () => {
    const buffer = new ToolResultBuffer();
    buffer.record(result('c1', 'stale'));
    const final = result('c1', 'fresh');
    buffer.record(final);

    expect(buffer.take(new Set(['c1']))).toEqual([['c1', final]]);
  });

  it('drops a failure that is not an object at all', async () => {
    const buffer = new ToolResultBuffer();
    const capture = createToolErrorCapture(buffer);

    await capture.run('the harness rejected the call');

    expect(buffer.size).toBe(0);
  });

  it('drops a failure that carries no tool name to correlate it with', async () => {
    // The hook signature is as broad as the SDK declares it, so a plain error
    // with no tool metadata can arrive; there is no call to pair it with.
    const buffer = new ToolResultBuffer();
    const capture = createToolErrorCapture(buffer);

    await capture.run(new Error('bare failure'));

    expect(buffer.size).toBe(0);
  });

  it('falls back to a generic message for a failure with an empty message', () => {
    const buffer = new ToolResultBuffer();

    buffer.recordError(failure('c1', ''));

    const [[, recorded]] = buffer.take(new Set(['c1']));
    expect(recorded.error).toBe('Tool call execution failed.');
  });

  it('leaves an unrequested id in the buffer', () => {
    const buffer = new ToolResultBuffer();
    buffer.record(result('c1', 'a'));

    expect(buffer.take(new Set(['c2']))).toEqual([]);
    expect(buffer.size).toBe(1);
  });
});
