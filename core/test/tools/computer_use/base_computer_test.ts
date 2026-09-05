/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isComputerState} from '@google/adk';
import {describe, expect, it} from 'vitest';

const SCREENSHOT = new TextEncoder().encode('test_screenshot');

describe('isComputerState', () => {
  it('accepts a state with and without a url', () => {
    expect(isComputerState({screenshot: SCREENSHOT})).toBe(true);
    expect(
      isComputerState({screenshot: SCREENSHOT, url: 'https://example.com'}),
    ).toBe(true);
    expect(isComputerState({screenshot: SCREENSHOT, url: undefined})).toBe(
      true,
    );
  });

  it('rejects a value that is not a state', () => {
    expect(isComputerState(null)).toBe(false);
    expect(isComputerState('screenshot')).toBe(false);
    expect(isComputerState({error: 'boom', url: 'https://example.com'})).toBe(
      false,
    );
    expect(isComputerState({screenshot: 'not-bytes'})).toBe(false);
    expect(isComputerState({screenshot: SCREENSHOT, url: 42})).toBe(false);
    expect(isComputerState({screenshot: SCREENSHOT, error: 'boom'})).toBe(
      false,
    );
  });
});
