/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseComputer,
  ComputerState,
  Context,
  createSession,
  InvocationContext,
  isComputerState,
  LlmAgent,
  PluginManager,
} from '@google/adk';
import {Environment} from '@google/genai';
import {describe, expect, it} from 'vitest';

const SCREENSHOT = new Uint8Array([1, 2, 3]);

/**
 * A computer that implements only the abstract members, so that the concrete
 * lifecycle hooks under test are the ones `BaseComputer` supplies.
 */
class BareComputer extends BaseComputer {
  async screenSize(): Promise<[number, number]> {
    return [1920, 1080];
  }
  async environment(): Promise<Environment> {
    return Environment.ENVIRONMENT_BROWSER;
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
    return {screenshot: SCREENSHOT, url: 'https://example.com'};
  }
}

function createToolContext(): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'base_computer_test_agent'}),
    session: createSession({id: 'test', appName: 'computer-use-test'}),
    pluginManager: new PluginManager([]),
  });

  return new Context({invocationContext, functionCallId: 'test-call'});
}

describe('BaseComputer', () => {
  it('supplies no-op lifecycle hooks a subclass need not override', async () => {
    const computer = new BareComputer();
    const context = createToolContext();

    await expect(computer.initialize()).resolves.toBeUndefined();
    await expect(computer.prepare(context)).resolves.toBeUndefined();
    await expect(computer.close()).resolves.toBeUndefined();

    // prepare() exists so an implementation can bind session state; the
    // default must leave the context alone.
    expect(context.actions.skipSummarization).toBeUndefined();
    expect(context.actions.stateDelta).toEqual({});
  });

  it('reports the screen size and environment the subclass declares', async () => {
    const computer = new BareComputer();

    expect(await computer.screenSize()).toEqual([1920, 1080]);
    expect(await computer.environment()).toBe(Environment.ENVIRONMENT_BROWSER);
  });

  it('returns the declared state from an action', async () => {
    const computer = new BareComputer();

    expect(await computer.currentState()).toEqual({
      screenshot: SCREENSHOT,
      url: 'https://example.com',
    });
  });
});

describe('isComputerState', () => {
  it.each([
    ['a screenshot only', {screenshot: SCREENSHOT}],
    ['a url only', {url: 'https://example.com'}],
    ['both fields', {screenshot: SCREENSHOT, url: 'https://example.com'}],
    ['an explicitly undefined field', {url: undefined}],
  ])('accepts %s', (_label, value) => {
    expect(isComputerState(value)).toBe(true);
  });

  it.each([
    ['an empty object', {}],
    ['an unrelated result object', {status: 'success'}],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'https://example.com'],
    ['a number', 42],
    ['an array', []],
    ['a non-string url', {url: 42}],
    ['a non-binary screenshot', {screenshot: 'not-bytes'}],
    ['a state carrying an extra key', {url: 'https://example.com', extra: 1}],
  ])('rejects %s', (_label, value) => {
    expect(isComputerState(value)).toBe(false);
  });

  it('accepts a screenshot from another realm', () => {
    // A Uint8Array built on a foreign ArrayBuffer stands in for a state
    // produced by a second copy of the package: `instanceof` would reject it.
    const foreign = new Uint8Array(new ArrayBuffer(3));

    expect(isComputerState({screenshot: foreign})).toBe(true);
  });
});
