/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';

import {retryOnce} from '../../src/utils/retry_utils.js';

/** An error that carries the `name` an aborted operation produces. */
function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

describe('retryOnce', () => {
  it('runs the operation once when it succeeds', async () => {
    const operation = vi.fn().mockResolvedValue('ok');

    await expect(retryOnce(operation, 'list')).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledOnce();
  });

  it('retries once and returns the second attempt', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('transport closed'))
      .mockResolvedValue('ok');

    await expect(retryOnce(operation, 'list')).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('throws the second error when both attempts fail', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'));

    await expect(retryOnce(operation, 'list')).rejects.toThrow('second');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not retry a cancellation', async () => {
    const operation = vi.fn().mockRejectedValue(abortError('cancelled'));

    await expect(retryOnce(operation, 'list')).rejects.toThrow('cancelled');
    expect(operation).toHaveBeenCalledOnce();
  });

  it('does not retry a cancellation nested in the cause chain', async () => {
    const wrapped = new Error('transport closed', {
      cause: abortError('cancelled'),
    });
    const operation = vi.fn().mockRejectedValue(wrapped);

    await expect(retryOnce(operation, 'list')).rejects.toThrow(
      'transport closed',
    );
    expect(operation).toHaveBeenCalledOnce();
  });
});
