/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseComputer,
  ComputerEnvironment,
  ComputerState,
  isComputerState,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {createToolContext} from './computer_use_test_utils.js';

/**
 * A driver that implements only the abstract members, so `prepare`,
 * `initialize` and `close` are the ones BaseComputer supplies.
 */
class MinimalComputer extends BaseComputer {
  async screenSize(): Promise<[number, number]> {
    return [800, 600];
  }
  async environment(): Promise<ComputerEnvironment> {
    return ComputerEnvironment.ENVIRONMENT_BROWSER;
  }
  async openWebBrowser(): Promise<ComputerState> {
    return {};
  }
  async clickAt(): Promise<ComputerState> {
    return {};
  }
  async hoverAt(): Promise<ComputerState> {
    return {};
  }
  async typeTextAt(): Promise<ComputerState> {
    return {};
  }
  async scrollDocument(): Promise<ComputerState> {
    return {};
  }
  async scrollAt(): Promise<ComputerState> {
    return {};
  }
  async wait(): Promise<ComputerState> {
    return {};
  }
  async goBack(): Promise<ComputerState> {
    return {};
  }
  async goForward(): Promise<ComputerState> {
    return {};
  }
  async search(): Promise<ComputerState> {
    return {};
  }
  async navigate(): Promise<ComputerState> {
    return {};
  }
  async keyCombination(): Promise<ComputerState> {
    return {};
  }
  async dragAndDrop(): Promise<ComputerState> {
    return {};
  }
  async currentState(): Promise<ComputerState> {
    return {};
  }
}

describe('ComputerEnvironment', () => {
  it('carries the wire values the API expects', () => {
    expect(ComputerEnvironment.ENVIRONMENT_UNSPECIFIED).toBe(
      'ENVIRONMENT_UNSPECIFIED',
    );
    expect(ComputerEnvironment.ENVIRONMENT_BROWSER).toBe('ENVIRONMENT_BROWSER');
  });
});

describe('isComputerState', () => {
  it.each([
    ['an empty state', {}],
    ['a url only', {url: 'https://example.com/'}],
    ['a screenshot only', {screenshot: new Uint8Array([1])}],
    ['both fields', {screenshot: new Uint8Array([1]), url: 'https://a.test/'}],
    ['an explicitly undefined field', {screenshot: undefined, url: undefined}],
  ])('accepts %s', (_name, value) => {
    expect(isComputerState(value)).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'https://example.com/'],
    ['a number', 42],
    ['an array', []],
  ])('rejects %s', (_name, value) => {
    expect(isComputerState(value)).toBe(false);
  });

  it('rejects the refused-navigate payload', () => {
    // The exactness matters here: read as a state, this payload would be
    // rewritten into a screenshot and the error would be dropped.
    expect(
      isComputerState({error: 'refused', url: 'https://example.com/'}),
    ).toBe(false);
  });

  it('rejects an object carrying an extra key', () => {
    expect(isComputerState({screenshot: new Uint8Array([1]), zoom: 2})).toBe(
      false,
    );
  });

  it('rejects a screenshot that is not bytes', () => {
    expect(isComputerState({screenshot: 'not-bytes'})).toBe(false);
  });

  it('rejects a url that is not a string', () => {
    expect(isComputerState({url: 42})).toBe(false);
  });
});

describe('BaseComputer defaults', () => {
  it('resolves prepare, initialize and close without doing anything', async () => {
    const computer = new MinimalComputer();

    await expect(
      computer.prepare(createToolContext()),
    ).resolves.toBeUndefined();
    await expect(computer.initialize()).resolves.toBeUndefined();
    await expect(computer.close()).resolves.toBeUndefined();
  });
});
