/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  LiveCloseCode,
  LiveConnectionClosedError,
  isLiveConnectionClosedError,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('LiveConnectionClosedError', () => {
  it('names the code and the reason in its message', () => {
    const error = new LiveConnectionClosedError(
      LiveCloseCode.ABNORMAL,
      'socket gone',
    );

    expect(error.message).toBe('live connection closed (1006): socket gone');
    expect(error.code).toBe(1006);
    expect(error.reason).toBe('socket gone');
  });

  it('names only the code when the server sent no reason', () => {
    const error = new LiveConnectionClosedError(LiveCloseCode.NORMAL);

    expect(error.message).toBe('live connection closed (1000)');
    expect(error.reason).toBeUndefined();
  });
});

describe('isLiveConnectionClosedError', () => {
  it('accepts a live connection close error', () => {
    expect(
      isLiveConnectionClosedError(
        new LiveConnectionClosedError(LiveCloseCode.INTERNAL),
      ),
    ).toBe(true);
  });

  it('rejects a plain error that carries a close code', () => {
    const impostor = Object.assign(new Error('unrelated'), {code: 1000});

    expect(isLiveConnectionClosedError(impostor)).toBe(false);
  });

  it('rejects values that are not errors', () => {
    expect(isLiveConnectionClosedError(undefined)).toBe(false);
    expect(isLiveConnectionClosedError(null)).toBe(false);
    expect(isLiveConnectionClosedError('live connection closed')).toBe(false);
  });
});
