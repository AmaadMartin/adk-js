/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseComputer,
  ComputerEnvironment,
  ComputerState,
  Context,
  createSession,
  InMemorySessionService,
  InvocationContext,
  isComputerState,
  LlmAgent,
  PluginManager,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** The smallest driver that satisfies the abstract surface. */
class MinimalComputer extends BaseComputer {
  async screenSize(): Promise<[number, number]> {
    return [1920, 1080];
  }
  async environment(): Promise<ComputerEnvironment> {
    return ComputerEnvironment.ENVIRONMENT_BROWSER;
  }
  async openWebBrowser(): Promise<ComputerState> {
    return {url: 'https://example.com'};
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
    return {url: 'https://example.com'};
  }
}

describe('ComputerEnvironment', () => {
  it('carries the exact wire strings', () => {
    expect(ComputerEnvironment.ENVIRONMENT_UNSPECIFIED).toBe(
      'ENVIRONMENT_UNSPECIFIED',
    );
    expect(ComputerEnvironment.ENVIRONMENT_BROWSER).toBe('ENVIRONMENT_BROWSER');
  });
});

describe('BaseComputer', () => {
  it('defaults prepare, initialize and close to resolving no-ops', async () => {
    const computer = new MinimalComputer();

    const context = new Context({
      invocationContext: new InvocationContext({
        invocationId: 'inv-1',
        agent: new LlmAgent({name: 'computer_agent'}),
        session: createSession({id: 's1', appName: 'app', userId: 'u1'}),
        pluginManager: new PluginManager([]),
        sessionService: new InMemorySessionService(),
      }),
    });

    await expect(computer.prepare(context)).resolves.toBeUndefined();
    await expect(computer.initialize()).resolves.toBeUndefined();
    await expect(computer.close()).resolves.toBeUndefined();
  });

  it('exposes the concrete subclass implementations', async () => {
    const computer = new MinimalComputer();

    expect(await computer.screenSize()).toEqual([1920, 1080]);
    expect(await computer.environment()).toBe(
      ComputerEnvironment.ENVIRONMENT_BROWSER,
    );
    expect(await computer.openWebBrowser()).toEqual({
      url: 'https://example.com',
    });
  });
});

describe('isComputerState', () => {
  it('accepts a state carrying a binary screenshot', () => {
    expect(
      isComputerState({screenshot: new Uint8Array([1, 2, 3]), url: 'u'}),
    ).toBe(true);
  });

  it('accepts a url-only state and an empty state', () => {
    expect(isComputerState({url: 'https://example.com'})).toBe(true);
    expect(isComputerState({})).toBe(true);
  });

  it('rejects null, a string and a number', () => {
    expect(isComputerState(null)).toBe(false);
    expect(isComputerState('state')).toBe(false);
    expect(isComputerState(7)).toBe(false);
  });

  it('rejects a screenshot that is not binary', () => {
    expect(isComputerState({screenshot: 'not-bytes'})).toBe(false);
  });

  it('rejects a url that is not a string', () => {
    expect(isComputerState({url: 42})).toBe(false);
  });

  it('rejects an object carrying any other key', () => {
    // The navigate refusal is `{error, url}`. A looser guard would read it as
    // a state and rewrite it into a screenshot payload, losing the error.
    expect(
      isComputerState({error: 'refused', url: 'https://example.com'}),
    ).toBe(false);
    expect(isComputerState({url: 'u', extra: 1})).toBe(false);
  });
});
