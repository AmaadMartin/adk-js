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
  InvocationContext,
  PluginManager,
  ScrollDirection,
  createSession,
  isComputerState,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const PAGE_URL = 'https://example.com';
const SEARCH_URL = 'https://search.example.com';
const SCREENSHOT = new Uint8Array([137, 80, 78, 71]);
const SCROLL_DIRECTIONS: ScrollDirection[] = ['up', 'down', 'left', 'right'];

/** A computer that implements every abstract member with a fixed result. */
class MockComputer extends BaseComputer {
  async screenSize(): Promise<[number, number]> {
    return [1920, 1080];
  }

  async environment(): Promise<ComputerEnvironment> {
    return ComputerEnvironment.ENVIRONMENT_BROWSER;
  }

  async openWebBrowser(): Promise<ComputerState> {
    return {url: PAGE_URL};
  }

  async clickAt(_params: {x: number; y: number}): Promise<ComputerState> {
    return {url: PAGE_URL};
  }

  async hoverAt(_params: {x: number; y: number}): Promise<ComputerState> {
    return {url: PAGE_URL};
  }

  async typeTextAt(_params: {
    x: number;
    y: number;
    text: string;
    pressEnter?: boolean;
    clearBeforeTyping?: boolean;
  }): Promise<ComputerState> {
    return {url: PAGE_URL};
  }

  async scrollDocument(_params: {
    direction: ScrollDirection;
  }): Promise<ComputerState> {
    return {url: PAGE_URL};
  }

  async scrollAt(_params: {
    x: number;
    y: number;
    direction: ScrollDirection;
    magnitude: number;
  }): Promise<ComputerState> {
    return {url: PAGE_URL};
  }

  async wait(_params: {seconds: number}): Promise<ComputerState> {
    return {url: PAGE_URL};
  }

  async goBack(): Promise<ComputerState> {
    return {url: PAGE_URL};
  }

  async goForward(): Promise<ComputerState> {
    return {url: PAGE_URL};
  }

  async search(): Promise<ComputerState> {
    return {url: SEARCH_URL};
  }

  async navigate(params: {url: string}): Promise<ComputerState> {
    return {url: params.url};
  }

  async keyCombination(_params: {keys: string[]}): Promise<ComputerState> {
    return {url: PAGE_URL};
  }

  async dragAndDrop(_params: {
    x: number;
    y: number;
    destinationX: number;
    destinationY: number;
  }): Promise<ComputerState> {
    return {url: PAGE_URL};
  }

  async currentState(): Promise<ComputerState> {
    return {url: PAGE_URL, screenshot: SCREENSHOT};
  }
}

/** A computer that overrides all three lifecycle hooks. */
class LifecycleComputer extends MockComputer {
  initialized = false;
  closed = false;
  prepared = false;

  override async initialize(): Promise<void> {
    this.initialized = true;
  }

  override async close(): Promise<void> {
    this.closed = true;
  }

  override async prepare(_context: Context): Promise<void> {
    this.prepared = true;
  }
}

function createContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager([]),
    }),
  });
}

describe('ComputerEnvironment', () => {
  it('keeps the browser value the wire expects', () => {
    expect(ComputerEnvironment.ENVIRONMENT_BROWSER).toBe('ENVIRONMENT_BROWSER');
  });

  it('keeps the unspecified value the wire expects', () => {
    expect(ComputerEnvironment.ENVIRONMENT_UNSPECIFIED).toBe(
      'ENVIRONMENT_UNSPECIFIED',
    );
  });

  it('declares exactly two environments', () => {
    expect(Object.values(ComputerEnvironment)).toEqual([
      'ENVIRONMENT_UNSPECIFIED',
      'ENVIRONMENT_BROWSER',
    ]);
  });
});

describe('isComputerState', () => {
  it('accepts an empty state', () => {
    expect(isComputerState({})).toBe(true);
  });

  it('accepts a state carrying only a url', () => {
    expect(isComputerState({url: PAGE_URL})).toBe(true);
  });

  it('accepts a state carrying only a screenshot', () => {
    expect(isComputerState({screenshot: new Uint8Array([1, 2, 3])})).toBe(true);
  });

  it('accepts a state carrying both fields', () => {
    expect(isComputerState({url: PAGE_URL, screenshot: SCREENSHOT})).toBe(true);
  });

  it('rejects null', () => {
    expect(isComputerState(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isComputerState(undefined)).toBe(false);
  });

  it('rejects a string', () => {
    expect(isComputerState('state')).toBe(false);
  });

  it('rejects a number', () => {
    expect(isComputerState(42)).toBe(false);
  });

  it('rejects an object carrying an extra key', () => {
    // The downstream tool reports a refused URL as {error, url}. A loose check
    // would read that error payload as a successful state.
    expect(isComputerState({url: PAGE_URL, error: 'refused'})).toBe(false);
  });

  it('rejects a non-string url', () => {
    expect(isComputerState({url: 5})).toBe(false);
  });

  it('rejects a string screenshot', () => {
    expect(isComputerState({screenshot: 'base64string'})).toBe(false);
  });

  it('rejects an array screenshot', () => {
    expect(isComputerState({screenshot: [1, 2, 3]})).toBe(false);
  });
});

describe('ComputerState', () => {
  it('survives a structured clone with its bytes intact', () => {
    // structuredClone is the transport for the binary field; JSON.stringify
    // turns a Uint8Array into an index-keyed object.
    const state: ComputerState = {url: PAGE_URL, screenshot: SCREENSHOT};

    const clone = structuredClone(state);

    expect(clone.url).toBe(PAGE_URL);
    expect(clone.screenshot).toBeInstanceOf(Uint8Array);
    expect(clone.screenshot).toEqual(SCREENSHOT);
  });
});

describe('BaseComputer', () => {
  it('leaves the abstract members without an implementation', () => {
    // TypeScript's `abstract` is erased at compile time, so Python's
    // "cannot instantiate" test has no runtime analogue.
    expect(BaseComputer.prototype.screenSize).toBeUndefined();
    expect(BaseComputer.prototype.openWebBrowser).toBeUndefined();
    expect(BaseComputer.prototype.clickAt).toBeUndefined();
    expect(BaseComputer.prototype.hoverAt).toBeUndefined();
    expect(BaseComputer.prototype.currentState).toBeUndefined();
  });

  it('implements the three lifecycle hooks', () => {
    expect(typeof BaseComputer.prototype.prepare).toBe('function');
    expect(typeof BaseComputer.prototype.initialize).toBe('function');
    expect(typeof BaseComputer.prototype.close).toBe('function');
  });

  it('resolves the default initialize()', async () => {
    await expect(new MockComputer().initialize()).resolves.toBeUndefined();
  });

  it('resolves the default close()', async () => {
    await expect(new MockComputer().close()).resolves.toBeUndefined();
  });

  it('resolves the default prepare() and leaves the context alone', async () => {
    const context = createContext();

    await expect(new MockComputer().prepare(context)).resolves.toBeUndefined();

    expect(context.state.toRecord()).toEqual({});
    expect(context.eventActions.stateDelta).toEqual({});
  });

  it('runs an overriding initialize() and close()', async () => {
    const computer = new LifecycleComputer();

    expect(computer.initialized).toBe(false);
    expect(computer.closed).toBe(false);

    await computer.initialize();
    await computer.close();

    expect(computer.initialized).toBe(true);
    expect(computer.closed).toBe(true);
  });

  it('runs an overriding prepare()', async () => {
    const computer = new LifecycleComputer();

    await computer.prepare(createContext());

    expect(computer.prepared).toBe(true);
  });

  it('reports the screen size as a width and height pair', async () => {
    const size = await new MockComputer().screenSize();

    expect(Array.isArray(size)).toBe(true);
    expect(size).toHaveLength(2);
    expect(size).toEqual([1920, 1080]);
  });

  it('reports the environment', async () => {
    await expect(new MockComputer().environment()).resolves.toBe(
      ComputerEnvironment.ENVIRONMENT_BROWSER,
    );
  });

  it('opens the web browser', async () => {
    const state = await new MockComputer().openWebBrowser();

    expect(isComputerState(state)).toBe(true);
    expect(state.url).toBe(PAGE_URL);
  });

  it('clicks at a coordinate', async () => {
    const state = await new MockComputer().clickAt({x: 100, y: 200});

    expect(isComputerState(state)).toBe(true);
  });

  it('hovers at a coordinate', async () => {
    const state = await new MockComputer().hoverAt({x: 150, y: 250});

    expect(isComputerState(state)).toBe(true);
  });

  it('types text with the default press-enter and clear behaviour', async () => {
    const state = await new MockComputer().typeTextAt({
      x: 100,
      y: 200,
      text: 'Hello World',
    });

    expect(isComputerState(state)).toBe(true);
  });

  it('types text with press-enter and clear turned off', async () => {
    const state = await new MockComputer().typeTextAt({
      x: 100,
      y: 200,
      text: 'Hello',
      pressEnter: false,
      clearBeforeTyping: false,
    });

    expect(isComputerState(state)).toBe(true);
  });

  it('scrolls the document in every direction', async () => {
    const computer = new MockComputer();

    for (const direction of SCROLL_DIRECTIONS) {
      const state = await computer.scrollDocument({direction});

      expect(isComputerState(state)).toBe(true);
    }
  });

  it('scrolls at a coordinate', async () => {
    const state = await new MockComputer().scrollAt({
      x: 100,
      y: 200,
      direction: 'down',
      magnitude: 5,
    });

    expect(isComputerState(state)).toBe(true);
  });

  it('waits for a number of seconds', async () => {
    const state = await new MockComputer().wait({seconds: 5});

    expect(isComputerState(state)).toBe(true);
  });

  it('navigates back', async () => {
    const state = await new MockComputer().goBack();

    expect(isComputerState(state)).toBe(true);
  });

  it('navigates forward', async () => {
    const state = await new MockComputer().goForward();

    expect(isComputerState(state)).toBe(true);
  });

  it('jumps to the search engine', async () => {
    const state = await new MockComputer().search();

    expect(state.url).toBe(SEARCH_URL);
  });

  it('navigates to a url', async () => {
    const url = 'https://test.example.com';

    const state = await new MockComputer().navigate({url});

    expect(state.url).toBe(url);
  });

  it('presses a key combination', async () => {
    const state = await new MockComputer().keyCombination({
      keys: ['ctrl', 'c'],
    });

    expect(isComputerState(state)).toBe(true);
  });

  it('drags and drops', async () => {
    const state = await new MockComputer().dragAndDrop({
      x: 100,
      y: 200,
      destinationX: 300,
      destinationY: 400,
    });

    expect(isComputerState(state)).toBe(true);
  });

  it('reports the current state with a screenshot', async () => {
    const state = await new MockComputer().currentState();

    expect(state.url).toBe(PAGE_URL);
    expect(state.screenshot).toEqual(SCREENSHOT);
  });
});
