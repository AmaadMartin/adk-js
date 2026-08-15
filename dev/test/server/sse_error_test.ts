/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {buildSseErrorPayload} from '../../src/server/sse_error.js';

/**
 * Stands in for `InvocationAbortedError`, which sets `this.name` but is not
 * re-exported from `@google/adk`. The payload builder reads `name`, so this
 * exercises the same path.
 */
class TestAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvocationAbortedError';
  }
}

/** Tolerance (seconds) allowed between the payload timestamp and the clock. */
const TIMESTAMP_TOLERANCE_SECONDS = 5;

describe('buildSseErrorPayload', () => {
  it('reports the type, the message and no stacktrace for a plain Error', () => {
    const payload = buildSseErrorPayload(new Error('model exploded'), false);

    expect(payload.error).toBe('Error: model exploded');
    expect(payload.error_details.error_type).toBe('Error');
    expect(payload.error_details.error_message).toBe('model exploded');
    expect('stacktrace' in payload.error_details).toBe(false);
  });

  it('reports the built-in subclass name as the error type', () => {
    const payload = buildSseErrorPayload(new TypeError('boom'), false);

    expect(payload.error).toBe('TypeError: boom');
    expect(payload.error_details.error_type).toBe('TypeError');
  });

  it('reports the name a custom error sets on itself', () => {
    const payload = buildSseErrorPayload(
      new TestAbortError('Invocation aborted.'),
      false,
    );

    expect(payload.error).toBe('InvocationAbortedError: Invocation aborted.');
    expect(payload.error_details.error_type).toBe('InvocationAbortedError');
  });

  it('attaches the stack trace when asked for it', () => {
    const payload = buildSseErrorPayload(new Error('model exploded'), true);

    expect(payload.error_details.stacktrace).toContain('model exploded');
  });

  it('omits the stacktrace when the thrown value carries no stack', () => {
    const payload = buildSseErrorPayload('boom', true);

    expect('stacktrace' in payload.error_details).toBe(false);
    expect(payload.error_details.error_message).toBe('boom');
  });

  it('omits the stacktrace when the stack is an empty string', () => {
    const error = new Error('model exploded');
    error.stack = '';

    const payload = buildSseErrorPayload(error, true);

    expect('stacktrace' in payload.error_details).toBe(false);
  });

  it('reports a thrown string as an Error', () => {
    const payload = buildSseErrorPayload('boom', false);

    expect(payload.error).toBe('Error: boom');
    expect(payload.error_details.error_type).toBe('Error');
    expect(payload.error_details.error_message).toBe('boom');
  });

  it.each([
    {label: 'null', thrown: null, message: 'null'},
    {label: 'undefined', thrown: undefined, message: 'undefined'},
    {label: 'a plain object', thrown: {}, message: '[object Object]'},
  ])('builds a serializable payload for $label', ({thrown, message}) => {
    const payload = buildSseErrorPayload(thrown, true);

    expect(payload.error_details.error_type).toBe('Error');
    expect(payload.error_details.error_message).toBe(message);
    expect(payload.error).toBe(`Error: ${message}`);
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it('reports the name of a duck-typed thrown object', () => {
    const payload = buildSseErrorPayload(
      {name: 'CustomFailure', message: 'x'},
      false,
    );

    expect(payload.error_details.error_type).toBe('CustomFailure');
  });

  it('falls back to Error when the name is an empty string', () => {
    const error = new Error('model exploded');
    error.name = '';

    const payload = buildSseErrorPayload(error, false);

    expect(payload.error_details.error_type).toBe('Error');
    expect(payload.error).toBe('Error: model exploded');
  });

  it('stamps the timestamp in epoch seconds, matching adk-python', () => {
    const payload = buildSseErrorPayload(new Error('model exploded'), false);

    expect(
      Math.abs(payload.error_details.timestamp - Date.now() / 1000),
    ).toBeLessThan(TIMESTAMP_TOLERANCE_SECONDS);
  });
});
