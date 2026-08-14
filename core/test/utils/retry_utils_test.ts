/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {retryOnce} from '../../src/utils/retry_utils.js';

/** Builds the error an aborted `AbortSignal` produces. */
function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

describe('retryOnce', () => {
  it('calls fn once when the first attempt resolves', async () => {
    const fn = vi.fn().mockResolvedValue('ok');

    await expect(retryOnce(fn, {description: 'test op'})).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('retries once and returns the second value when the first attempt rejects', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue('recovered');

    await expect(retryOnce(fn, {description: 'test op'})).resolves.toBe(
      'recovered',
    );
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('rejects with the second error when both attempts reject', async () => {
    const second = new Error('second failure');
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValue(second);

    await expect(retryOnce(fn, {description: 'test op'})).rejects.toBe(second);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry when the signal is already aborted', async () => {
    const failure = new Error('closed');
    const fn = vi.fn().mockRejectedValue(failure);
    const controller = new AbortController();
    controller.abort();

    await expect(
      retryOnce(fn, {signal: controller.signal, description: 'test op'}),
    ).rejects.toBe(failure);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('does not retry an AbortError', async () => {
    const failure = abortError();
    const fn = vi.fn().mockRejectedValue(failure);

    await expect(retryOnce(fn, {description: 'test op'})).rejects.toBe(failure);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('does not retry an error wrapping an AbortError as its cause', async () => {
    const failure = new Error('closed', {cause: abortError()});
    const fn = vi.fn().mockRejectedValue(failure);

    await expect(retryOnce(fn, {description: 'test op'})).rejects.toBe(failure);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('retries when fn rejects with a non-Error value', async () => {
    const fn = vi.fn().mockRejectedValueOnce('boom').mockResolvedValue('ok');

    await expect(retryOnce(fn, {description: 'test op'})).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
