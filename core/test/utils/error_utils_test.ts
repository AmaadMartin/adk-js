/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ApiError} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  formatError,
  getApiErrorDetails,
  isAbortError,
  isFileNotFoundError,
  isNotFoundError,
  timeoutErrorName,
  truncateBody,
} from '../../src/utils/error_utils.js';

const TRUNCATION_MARKER = '... [truncated]';
const MAX_RESPONSE_BODY_LENGTH = 1000;

/** Builds an axios/httpx-style error carrying a `.response` object. */
function httpError(status: number, body: string, statusText?: string): Error {
  return Object.assign(new Error(`request failed with status ${status}`), {
    response: {status, statusText, data: body},
  });
}

describe('formatError', () => {
  it('returns the message of a single plain error', () => {
    expect(formatError(new Error('normal error'))).toBe('normal error');
  });

  it('surfaces the leaf message of an error wrapped via cause', () => {
    const err = new Error('outer', {cause: new Error('root cause')});
    expect(formatError(err)).toContain('root cause');
  });

  it('joins an AggregateError of multiple sub-errors with " | "', () => {
    const err = new AggregateError([new Error('err A'), new Error('err B')]);
    const result = formatError(err);
    expect(result).toContain('err A');
    expect(result).toContain('err B');
    expect(result).toContain(' | ');
  });

  it('surfaces every leaf of an AggregateError mixing HTTP and plain errors', () => {
    const err = new AggregateError([
      httpError(403, 'Forbidden access', 'Forbidden'),
      new Error('another error'),
    ]);
    const result = formatError(err);
    expect(result).toContain('403');
    expect(result).toContain('Forbidden access');
    expect(result).toContain('another error');
  });

  it('extracts status and body from an HTTP 403 response shape', () => {
    const err = httpError(403, 'Forbidden access', 'Forbidden');
    const result = formatError(err);
    expect(result).toContain('403');
    expect(result).toContain('Forbidden access');
  });

  it('extracts status and body from an HTTP 401 response shape', () => {
    const err = httpError(401, 'Missing credentials', 'Unauthorized');
    const result = formatError(err);
    expect(result).toContain('401');
    expect(result).toContain('Missing credentials');
  });

  it('extracts the status from a StreamableHTTPError-shaped error', () => {
    const err = Object.assign(
      new Error(
        'Streamable HTTP error: Error POSTing to endpoint: {"error":"forbidden"}',
      ),
      {code: 403},
    );
    const result = formatError(err);
    expect(result).toContain('403');
    expect(result).toContain('forbidden');
  });

  it('truncates a long response body to the configured maximum', () => {
    const err = httpError(500, 'x'.repeat(5000));
    const result = formatError(err);
    expect(result).toContain(TRUNCATION_MARKER);
    expect(result).toContain('x'.repeat(MAX_RESPONSE_BODY_LENGTH));
    expect(result).not.toContain('x'.repeat(MAX_RESPONSE_BODY_LENGTH + 1));
  });

  it('does not truncate a body of exactly the maximum length', () => {
    const err = httpError(500, 'y'.repeat(MAX_RESPONSE_BODY_LENGTH));
    const result = formatError(err);
    expect(result).not.toContain(TRUNCATION_MARKER);
    expect(result).toContain('y'.repeat(MAX_RESPONSE_BODY_LENGTH));
  });

  it('truncates a body one character over the maximum length', () => {
    const err = httpError(500, 'z'.repeat(MAX_RESPONSE_BODY_LENGTH + 1));
    expect(formatError(err)).toContain(TRUNCATION_MARKER);
  });

  it('extracts HTTP details from a leaf error reached via the cause chain', () => {
    const err = new Error('connection failed', {
      cause: httpError(403, 'Forbidden access', 'Forbidden'),
    });
    const result = formatError(err);
    expect(result).toContain('403');
    expect(result).toContain('Forbidden access');
  });

  it('returns a stable constant for null and undefined', () => {
    expect(formatError(null)).toBe('Unknown error');
    expect(formatError(undefined)).toBe('Unknown error');
  });

  it('returns a raw string input verbatim', () => {
    expect(formatError('raw string')).toBe('raw string');
  });

  it('returns a non-empty string for a non-Error object without throwing', () => {
    const result = formatError({foo: 1});
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('is safe against a self-referential cause cycle', () => {
    const err = new Error('self');
    err.cause = err;
    expect(formatError(err)).toBe('self');
  });

  it('is safe against an AggregateError that contains itself', () => {
    const err = new AggregateError([new Error('leaf')]);
    err.errors.push(err);
    expect(() => formatError(err)).not.toThrow();
    expect(formatError(err)).toContain('leaf');
  });

  it('does not treat a string Node system code as an HTTP status', () => {
    const err = Object.assign(new Error('conn refused'), {
      code: 'ECONNREFUSED',
    });
    const result = formatError(err);
    expect(result).toBe('conn refused');
    expect(result).not.toContain('HTTP');
  });

  it('reads the status when the response object is null', () => {
    const err = Object.assign(new Error('boom'), {status: 403, response: null});
    expect(formatError(err)).toContain('403');
  });

  it('surfaces a response body even when no status is available', () => {
    const err = Object.assign(new Error('boom'), {
      response: {data: 'body without status'},
    });
    const result = formatError(err);
    expect(result).toContain('body without status');
    expect(result).toContain('HTTP error');
  });

  it('ignores a negative numeric code (e.g. JSON-RPC) as an HTTP status', () => {
    const err = Object.assign(new Error('rpc failure'), {code: -32601});
    const result = formatError(err);
    expect(result).toBe('rpc failure');
    expect(result).not.toContain('HTTP');
  });

  it('ignores an out-of-range numeric code as an HTTP status', () => {
    const err = Object.assign(new Error('weird code'), {code: 9999});
    const result = formatError(err);
    expect(result).toBe('weird code');
    expect(result).not.toContain('9999');
  });

  it('does not invoke or surface a function-valued response text', () => {
    const err = Object.assign(new Error('boom'), {
      response: {status: 500, text: () => 'should not be read'},
    });
    const result = formatError(err);
    expect(result).toContain('500');
    expect(result).not.toContain('should not be read');
  });

  it('returns the unknown-error constant for an empty AggregateError', () => {
    expect(formatError(new AggregateError([]))).toBe('Unknown error');
  });

  it('does not append the cause when the base already has HTTP details', () => {
    const err = Object.assign(new Error('outer'), {
      code: 403,
      cause: new Error('inner detail'),
    });
    const result = formatError(err);
    expect(result).toContain('HTTP 403');
    expect(result).not.toContain('inner detail');
  });

  it('does not duplicate a cause message already present in the base', () => {
    const err = new Error('wrapper failed: boom', {cause: new Error('boom')});
    expect(formatError(err)).toBe('wrapper failed: boom');
  });

  it('reads a string response body from the "body" field', () => {
    const err = Object.assign(new Error('boom'), {
      response: {status: 502, body: 'gateway body'},
    });
    expect(formatError(err)).toContain('gateway body');
  });

  it('reads a string response body from the "text" field', () => {
    const err = Object.assign(new Error('boom'), {
      response: {status: 502, text: 'text body'},
    });
    expect(formatError(err)).toContain('text body');
  });
});

describe('isAbortError', () => {
  it('reports an AbortError', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(isAbortError(err)).toBe(true);
  });

  it('reports a TimeoutError', () => {
    const err = new Error('timed out');
    err.name = 'TimeoutError';
    expect(isAbortError(err)).toBe(true);
  });

  it('reports an ordinary error as not a cancellation', () => {
    expect(isAbortError(new Error('boom'))).toBe(false);
  });

  it('finds a cancellation wrapped as a cause', () => {
    const inner = new Error('aborted');
    inner.name = 'AbortError';
    const outer = new Error('failed to connect', {cause: inner});
    expect(isAbortError(outer)).toBe(true);
  });

  it('finds a cancellation two causes deep', () => {
    const inner = Object.assign(new Error('cancelled'), {name: 'AbortError'});
    const middle = new Error('transport closed', {cause: inner});
    expect(isAbortError(new Error('call failed', {cause: middle}))).toBe(true);
  });

  it('finds a cancellation inside an AggregateError', () => {
    const inner = new Error('aborted');
    inner.name = 'AbortError';
    expect(isAbortError(new AggregateError([new Error('boom'), inner]))).toBe(
      true,
    );
  });

  it('returns false for an AggregateError with no cancellation', () => {
    expect(isAbortError(new AggregateError([new Error('boom')]))).toBe(false);
  });

  it('is safe on null, undefined and primitives', () => {
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
  });

  it('terminates on a cyclic cause chain', () => {
    const err: Error & {cause?: unknown} = new Error('outer');
    err.cause = err;
    expect(isAbortError(err)).toBe(false);
  });
});

describe('truncateBody', () => {
  it('appends the marker to a body over the cap', () => {
    const body = 'x'.repeat(MAX_RESPONSE_BODY_LENGTH + 1);

    expect(truncateBody(body)).toBe(
      'x'.repeat(MAX_RESPONSE_BODY_LENGTH) + TRUNCATION_MARKER,
    );
  });

  it('leaves a body at the cap untouched', () => {
    const body = 'x'.repeat(MAX_RESPONSE_BODY_LENGTH);

    expect(truncateBody(body)).toBe(body);
  });
});

describe('timeoutErrorName', () => {
  it('names a bare abort timeout', () => {
    const err = new DOMException(
      'The operation was aborted due to timeout',
      'TimeoutError',
    );
    expect(timeoutErrorName(err)).toBe('TimeoutError');
  });

  it('names an undici timeout two cause levels down', () => {
    const transport = Object.assign(new Error('Connect Timeout Error'), {
      name: 'ConnectTimeoutError',
      code: 'UND_ERR_CONNECT_TIMEOUT',
    });
    const err = new TypeError('fetch failed', {
      cause: new Error('socket', {cause: transport}),
    });
    expect(timeoutErrorName(err)).toBe('ConnectTimeoutError');
  });

  it('names a timeout held by an AggregateError', () => {
    const err = new AggregateError([
      new Error('first attempt'),
      Object.assign(new Error('read stalled'), {name: 'BodyTimeoutError'}),
    ]);
    expect(timeoutErrorName(err)).toBe('BodyTimeoutError');
  });

  it('reports the code when the name is not a timeout name', () => {
    const err = Object.assign(new Error('connect ETIMEDOUT'), {
      code: 'ETIMEDOUT',
    });
    expect(timeoutErrorName(err)).toBe('ETIMEDOUT');
  });

  it('reports the code of a timeout that carries no name', () => {
    expect(timeoutErrorName({code: 'UND_ERR_HEADERS_TIMEOUT'})).toBe(
      'UND_ERR_HEADERS_TIMEOUT',
    );
  });

  it('prefers a timeout name over the code that accompanies it', () => {
    const err = Object.assign(new Error('read stalled'), {
      name: 'BodyTimeoutError',
      code: 'UND_ERR_BODY_TIMEOUT',
    });
    expect(timeoutErrorName(err)).toBe('BodyTimeoutError');
  });

  it('returns undefined for a plain error', () => {
    expect(timeoutErrorName(new Error('boom'))).toBeUndefined();
  });

  it('returns undefined for a null, a string and a number', () => {
    expect(timeoutErrorName(null)).toBeUndefined();
    expect(timeoutErrorName('TimeoutError')).toBeUndefined();
    expect(timeoutErrorName(42)).toBeUndefined();
  });

  it('returns on a self-referential cause cycle', () => {
    const err: Error & {cause?: unknown} = new Error('cyclic');
    err.cause = err;
    expect(timeoutErrorName(err)).toBeUndefined();
  });

  it('returns on a cycle between two aggregated errors', () => {
    const first = new AggregateError([], 'first');
    const second = new AggregateError([first], 'second');
    first.errors.push(second);
    expect(timeoutErrorName(second)).toBeUndefined();
  });
});

describe('isNotFoundError', () => {
  it('matches the gRPC NOT_FOUND code', () => {
    expect(isNotFoundError(Object.assign(new Error('gone'), {code: 5}))).toBe(
      true,
    );
  });

  it('matches an HTTP 404 in the code field', () => {
    expect(isNotFoundError(Object.assign(new Error('gone'), {code: 404}))).toBe(
      true,
    );
  });

  it('matches an HTTP 404 in the status field', () => {
    expect(
      isNotFoundError(Object.assign(new Error('gone'), {status: 404})),
    ).toBe(true);
  });

  it('rejects another server status', () => {
    expect(
      isNotFoundError(Object.assign(new Error('boom'), {status: 500})),
    ).toBe(false);
  });

  it('rejects an error carrying no status at all', () => {
    expect(isNotFoundError(new Error('boom'))).toBe(false);
  });

  it('rejects null and undefined', () => {
    expect(isNotFoundError(null)).toBe(false);
    expect(isNotFoundError(undefined)).toBe(false);
  });
});

describe('isFileNotFoundError', () => {
  it('accepts a Node ENOENT error', () => {
    const err = Object.assign(new Error('no such file'), {code: 'ENOENT'});
    expect(isFileNotFoundError(err)).toBe(true);
  });

  it('accepts a plain object carrying the code', () => {
    expect(isFileNotFoundError({code: 'ENOENT'})).toBe(true);
  });

  it('rejects a different error code', () => {
    const err = Object.assign(new Error('permission denied'), {code: 'EACCES'});
    expect(isFileNotFoundError(err)).toBe(false);
  });

  it('rejects an error carrying no code', () => {
    expect(isFileNotFoundError(new Error('boom'))).toBe(false);
  });

  it('rejects a non-object value', () => {
    expect(isFileNotFoundError('ENOENT')).toBe(false);
    expect(isFileNotFoundError(null)).toBe(false);
    expect(isFileNotFoundError(undefined)).toBe(false);
  });
});

describe('getApiErrorDetails', () => {
  it('reads the canonical status and message out of the JSON body', () => {
    const error = new ApiError({
      status: 429,
      message: JSON.stringify({
        error: {code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota.'},
      }),
    });

    expect(getApiErrorDetails(error)).toEqual({
      status: 'RESOURCE_EXHAUSTED',
      message: 'Quota.',
    });
  });

  it('parses the body the streaming path prefixes with "got status:"', () => {
    const body = JSON.stringify({
      error: {code: 500, status: 'INTERNAL', message: 'Backend failure.'},
    });
    const error = new ApiError({
      status: 500,
      message: `got status: INTERNAL. ${body}`,
    });

    expect(getApiErrorDetails(error)).toEqual({
      status: 'INTERNAL',
      message: 'Backend failure.',
    });
  });

  it('falls back to the numeric status when the body carries no JSON', () => {
    const error = new ApiError({status: 503, message: 'service unavailable'});

    expect(getApiErrorDetails(error)).toEqual({
      status: '503',
      message: 'service unavailable',
    });
  });

  it('falls back when the body is a brace that does not parse', () => {
    const error = new ApiError({status: 400, message: 'bad {not json'});

    expect(getApiErrorDetails(error)).toEqual({
      status: '400',
      message: 'bad {not json',
    });
  });

  it('falls back when the parsed body carries no error object', () => {
    const error = new ApiError({status: 400, message: '{"other": 1}'});

    expect(getApiErrorDetails(error)).toEqual({
      status: '400',
      message: '{"other": 1}',
    });
  });

  it('returns undefined for a value that is not an API error', () => {
    expect(getApiErrorDetails(new Error('plain'))).toBeUndefined();
    expect(getApiErrorDetails(undefined)).toBeUndefined();
    expect(getApiErrorDetails('boom')).toBeUndefined();
    expect(getApiErrorDetails({status: 500})).toBeUndefined();
    expect(getApiErrorDetails({message: 'no status'})).toBeUndefined();
  });
});
