/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseComputer,
  ComputerEnvironment,
  ComputerState,
  ScrollDirection,
  isComputerState,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {
  MOCK_PAGE_URL,
  MOCK_SCREENSHOT,
  MockComputer,
  createToolContext,
} from './computer_use_test_utils.js';

/**
 * A computer that implements only the abstract methods, so the base class
 * defaults for `prepare`, `initialize` and `close` are the ones under test.
 */
class BareComputer extends BaseComputer {
  private readonly state: ComputerState = {screenshot: MOCK_SCREENSHOT};

  async screenSize() {
    return {width: 800, height: 600};
  }
  async environment() {
    return ComputerEnvironment.ENVIRONMENT_UNSPECIFIED;
  }
  async openWebBrowser() {
    return this.state;
  }
  async clickAt(_x: number, _y: number) {
    return this.state;
  }
  async hoverAt(_x: number, _y: number) {
    return this.state;
  }
  async typeTextAt(_x: number, _y: number, _text: string) {
    return this.state;
  }
  async scrollDocument(_direction: ScrollDirection) {
    return this.state;
  }
  async scrollAt(
    _x: number,
    _y: number,
    _direction: ScrollDirection,
    _magnitude: number,
  ) {
    return this.state;
  }
  async wait(_seconds: number) {
    return this.state;
  }
  async goBack() {
    return this.state;
  }
  async goForward() {
    return this.state;
  }
  async search() {
    return this.state;
  }
  async navigate(_url: string) {
    return this.state;
  }
  async keyCombination(_keys: string[]) {
    return this.state;
  }
  async dragAndDrop(
    _x: number,
    _y: number,
    _destinationX: number,
    _destinationY: number,
  ) {
    return this.state;
  }
  async currentState() {
    return this.state;
  }
}

describe('ComputerEnvironment', () => {
  it('carries the wire values the model configuration uses', () => {
    expect(ComputerEnvironment.ENVIRONMENT_UNSPECIFIED).toBe(
      'ENVIRONMENT_UNSPECIFIED',
    );
    expect(ComputerEnvironment.ENVIRONMENT_BROWSER).toBe('ENVIRONMENT_BROWSER');
  });
});

describe('isComputerState', () => {
  it('accepts a state with a url', () => {
    expect(isComputerState({screenshot: MOCK_SCREENSHOT, url: 'a'})).toBe(true);
  });

  it('accepts a state without a url', () => {
    expect(isComputerState({screenshot: MOCK_SCREENSHOT})).toBe(true);
  });

  it('accepts a state whose url is explicitly undefined', () => {
    expect(isComputerState({screenshot: MOCK_SCREENSHOT, url: undefined})).toBe(
      true,
    );
  });

  it('rejects an object with no screenshot', () => {
    expect(isComputerState({url: 'https://example.com'})).toBe(false);
  });

  it('rejects a screenshot that is not bytes', () => {
    expect(isComputerState({screenshot: 'not-bytes'})).toBe(false);
  });

  it('rejects a state whose url is not a string', () => {
    expect(isComputerState({screenshot: MOCK_SCREENSHOT, url: 5})).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isComputerState(null)).toBe(false);
    expect(isComputerState('state')).toBe(false);
  });
});

describe('BaseComputer defaults', () => {
  it('does nothing on prepare, initialize and close', async () => {
    const computer = new BareComputer();

    await expect(
      computer.prepare(createToolContext()),
    ).resolves.toBeUndefined();
    await expect(computer.initialize()).resolves.toBeUndefined();
    await expect(computer.close()).resolves.toBeUndefined();
  });
});

describe('BaseComputer subclass dispatch', () => {
  const computer = new MockComputer();

  it('reports its screen size and environment', async () => {
    expect(await computer.screenSize()).toEqual({width: 1920, height: 1080});
    expect(await computer.environment()).toBe(
      ComputerEnvironment.ENVIRONMENT_BROWSER,
    );
  });

  it('dispatches every action to the subclass', async () => {
    expect((await computer.openWebBrowser()).url).toBe(MOCK_PAGE_URL);
    expect((await computer.clickAt(1, 2)).url).toBe(
      `${MOCK_PAGE_URL}/click/1/2`,
    );
    expect((await computer.hoverAt(3, 4)).url).toBe(
      `${MOCK_PAGE_URL}/hover/3/4`,
    );
    expect((await computer.typeTextAt(5, 6, 'hi', false, false)).url).toBe(
      `${MOCK_PAGE_URL}/type/5/6/hi/false/false`,
    );
    expect((await computer.scrollDocument('down')).url).toBe(
      `${MOCK_PAGE_URL}/scroll/down`,
    );
    expect((await computer.scrollAt(7, 8, 'up', 9)).url).toBe(
      `${MOCK_PAGE_URL}/scroll/7/8/up/9`,
    );
    expect((await computer.wait(2)).url).toBe(`${MOCK_PAGE_URL}/wait/2`);
    expect((await computer.goBack()).url).toBe(`${MOCK_PAGE_URL}/back`);
    expect((await computer.goForward()).url).toBe(`${MOCK_PAGE_URL}/forward`);
    expect((await computer.search()).url).toBe(`${MOCK_PAGE_URL}/search`);
    expect((await computer.navigate('https://a.test/')).url).toBe(
      'https://a.test/',
    );
    expect((await computer.keyCombination(['control', 'c'])).url).toBe(
      `${MOCK_PAGE_URL}/keys/control+c`,
    );
    expect((await computer.dragAndDrop(1, 2, 3, 4)).url).toBe(
      `${MOCK_PAGE_URL}/drag/1/2/3/4`,
    );
    expect((await computer.currentState()).url).toBe(MOCK_PAGE_URL);
  });

  it('records the lifecycle calls the toolset makes', async () => {
    const lifecycleComputer = new MockComputer();
    const toolContext = createToolContext();

    await lifecycleComputer.initialize();
    await lifecycleComputer.prepare(toolContext);
    await lifecycleComputer.close();

    expect(lifecycleComputer.initializeCalled).toBe(1);
    expect(lifecycleComputer.prepareCalls).toEqual([toolContext]);
    expect(lifecycleComputer.closeCalled).toBe(1);
  });
});
