/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';

import {retryOnce} from '../../src/utils/retry_utils.js';

function abortError(message = 'The operation was aborted'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

describe('retryOnce', () => {
  it('returns the first attempt when it succeeds', async () => {
    const operation = vi.fn().mockResolvedValue('session');

    await expect(retryOnce(operation, 'setup')).resolves.toBe('session');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries once and returns the second attempt', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('transport reset'))
      .mockResolvedValue('session');

    await expect(retryOnce(operation, 'setup')).resolves.toBe('session');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('gives up after the second attempt fails', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'));

    await expect(retryOnce(operation, 'setup')).rejects.toThrow('second');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not retry a cancellation', async () => {
    const operation = vi.fn().mockRejectedValue(abortError());

    await expect(retryOnce(operation, 'setup')).rejects.toThrow(
      'The operation was aborted',
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not retry an AbortError nested in the cause chain', async () => {
    const wrapped = new Error('transport closed', {
      cause: new Error('teardown', {cause: abortError()}),
    });
    const operation = vi.fn().mockRejectedValue(wrapped);

    await expect(retryOnce(operation, 'setup')).rejects.toThrow(
      'transport closed',
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the abort signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn().mockRejectedValue(new Error('transport reset'));

    await expect(
      retryOnce(operation, 'setup', controller.signal),
    ).rejects.toThrow('transport reset');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries when the abort signal is present but not aborted', async () => {
    const controller = new AbortController();
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('transport reset'))
      .mockResolvedValue('session');

    await expect(
      retryOnce(operation, 'setup', controller.signal),
    ).resolves.toBe('session');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('terminates on a cyclic cause chain', async () => {
    const first = new Error('first');
    const second = new Error('second', {cause: first});
    Object.defineProperty(first, 'cause', {value: second, writable: true});
    const operation = vi
      .fn()
      .mockRejectedValueOnce(second)
      .mockResolvedValue('session');

    await expect(retryOnce(operation, 'setup')).resolves.toBe('session');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('retries a thrown value that is not an object', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce('transport reset')
      .mockResolvedValue('session');

    await expect(retryOnce(operation, 'setup')).resolves.toBe('session');
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
