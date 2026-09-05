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
  LlmAgent,
  PluginManager,
  ScrollDirection,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const SCREENSHOT = new TextEncoder().encode('fake_png_data');
const PAGE_URL = 'https://example.com';
const SEARCH_URL = 'https://search.example.com';

/**
 * A complete implementation of the contract, of the shape a user writes.
 *
 * It keeps the three default lifecycle hooks, so they stay exercised.
 */
class MockComputer extends BaseComputer {
  clicked?: {x: number; y: number};
  hovered?: {x: number; y: number};
  typed?: {
    x: number;
    y: number;
    text: string;
    pressEnter?: boolean;
    clearBeforeTyping?: boolean;
  };
  documentScroll?: {direction: ScrollDirection};
  pointScroll?: {
    x: number;
    y: number;
    direction: ScrollDirection;
    magnitude: number;
  };
  waited?: {seconds: number};
  pressedKeys?: string[];
  dragged?: {
    x: number;
    y: number;
    destinationX: number;
    destinationY: number;
  };

  async screenSize(): Promise<[number, number]> {
    return [1920, 1080];
  }

  async environment(): Promise<ComputerEnvironment> {
    return ComputerEnvironment.ENVIRONMENT_BROWSER;
  }

  async openWebBrowser(): Promise<ComputerState> {
    return {url: PAGE_URL};
  }

  async clickAt(params: {x: number; y: number}): Promise<ComputerState> {
    this.clicked = params;
    return {url: PAGE_URL};
  }

  async hoverAt(params: {x: number; y: number}): Promise<ComputerState> {
    this.hovered = params;
    return {url: PAGE_URL};
  }

  async typeTextAt(params: {
    x: number;
    y: number;
    text: string;
    pressEnter?: boolean;
    clearBeforeTyping?: boolean;
  }): Promise<ComputerState> {
    this.typed = params;
    return {url: PAGE_URL};
  }

  async scrollDocument(params: {
    direction: ScrollDirection;
  }): Promise<ComputerState> {
    this.documentScroll = params;
    return {url: PAGE_URL};
  }

  async scrollAt(params: {
    x: number;
    y: number;
    direction: ScrollDirection;
    magnitude: number;
  }): Promise<ComputerState> {
    this.pointScroll = params;
    return {url: PAGE_URL};
  }

  async wait(params: {seconds: number}): Promise<ComputerState> {
    this.waited = params;
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

  async keyCombination(params: {keys: string[]}): Promise<ComputerState> {
    this.pressedKeys = params.keys;
    return {url: PAGE_URL};
  }

  async dragAndDrop(params: {
    x: number;
    y: number;
    destinationX: number;
    destinationY: number;
  }): Promise<ComputerState> {
    this.dragged = params;
    return {url: PAGE_URL};
  }

  async currentState(): Promise<ComputerState> {
    return {url: PAGE_URL, screenshot: SCREENSHOT};
  }
}

/** A subclass whose `currentState()` reports a caller-chosen state. */
class StateComputer extends MockComputer {
  constructor(private readonly state: ComputerState) {
    super();
  }

  override async currentState(): Promise<ComputerState> {
    return this.state;
  }
}

/** A subclass that overrides the three lifecycle hooks and records them. */
class LifecycleComputer extends MockComputer {
  prepared = false;
  initialized = false;
  closed = false;
  preparedFor?: Context;

  override async prepare(context: Context): Promise<void> {
    this.preparedFor = context;
    this.prepared = true;
  }

  override async initialize(): Promise<void> {
    this.initialized = true;
  }

  override async close(): Promise<void> {
    this.closed = true;
  }
}

function createContext(): Context {
  const session = createSession({id: 'test-session', appName: 'test-app'});
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test_agent'}),
    session,
    pluginManager: new PluginManager([]),
    sessionService: new InMemorySessionService(),
  });
  return new Context({invocationContext});
}

describe('ComputerEnvironment', () => {
  it('keeps the adk-python string values', () => {
    expect(ComputerEnvironment.ENVIRONMENT_UNSPECIFIED).toBe(
      'ENVIRONMENT_UNSPECIFIED',
    );
    expect(ComputerEnvironment.ENVIRONMENT_BROWSER).toBe('ENVIRONMENT_BROWSER');
  });

  it('declares exactly the adk-python members', () => {
    expect(Object.values(ComputerEnvironment)).toEqual([
      'ENVIRONMENT_UNSPECIFIED',
      'ENVIRONMENT_BROWSER',
    ]);
  });
});

describe('ComputerState', () => {
  it('reports both properties absent', async () => {
    const state = await new StateComputer({}).currentState();
    expect(state.screenshot).toBeUndefined();
    expect(state.url).toBeUndefined();
  });

  it('reports a screenshot on its own', async () => {
    const state = await new StateComputer({
      screenshot: SCREENSHOT,
    }).currentState();
    expect(state.screenshot).toEqual(SCREENSHOT);
    expect(state.url).toBeUndefined();
  });

  it('reports a url on its own', async () => {
    const state = await new StateComputer({url: PAGE_URL}).currentState();
    expect(state.screenshot).toBeUndefined();
    expect(state.url).toBe(PAGE_URL);
  });

  it('reports both properties together', async () => {
    const state = await new StateComputer({
      screenshot: SCREENSHOT,
      url: PAGE_URL,
    }).currentState();
    expect(state.screenshot).toEqual(SCREENSHOT);
    expect(state.url).toBe(PAGE_URL);
  });

  it('exposes no property beyond the two', async () => {
    const state = await new StateComputer({
      screenshot: SCREENSHOT,
      url: PAGE_URL,
    }).currentState();
    expect(Object.keys(state).sort()).toEqual(['screenshot', 'url']);
  });
});

describe('BaseComputer', () => {
  it('reports the screen size as a width and height pair', async () => {
    const size = await new MockComputer().screenSize();
    expect(size).toEqual([1920, 1080]);
    expect(size).toHaveLength(2);
  });

  it('reports the environment', async () => {
    expect(await new MockComputer().environment()).toBe(
      ComputerEnvironment.ENVIRONMENT_BROWSER,
    );
  });

  it('opens the web browser', async () => {
    expect(await new MockComputer().openWebBrowser()).toEqual({url: PAGE_URL});
  });

  it('clicks at a coordinate', async () => {
    const computer = new MockComputer();
    expect(await computer.clickAt({x: 100, y: 200})).toEqual({url: PAGE_URL});
    expect(computer.clicked).toEqual({x: 100, y: 200});
  });

  it('hovers at a coordinate', async () => {
    const computer = new MockComputer();
    expect(await computer.hoverAt({x: 150, y: 250})).toEqual({url: PAGE_URL});
    expect(computer.hovered).toEqual({x: 150, y: 250});
  });

  it('types text with the two flags left to the implementation', async () => {
    const computer = new MockComputer();
    expect(
      await computer.typeTextAt({x: 100, y: 200, text: 'Hello World'}),
    ).toEqual({url: PAGE_URL});
    expect(computer.typed).toEqual({x: 100, y: 200, text: 'Hello World'});
    expect(computer.typed?.pressEnter).toBeUndefined();
    expect(computer.typed?.clearBeforeTyping).toBeUndefined();
  });

  it('types text with both flags turned off', async () => {
    const computer = new MockComputer();
    await computer.typeTextAt({
      x: 100,
      y: 200,
      text: 'Hello',
      pressEnter: false,
      clearBeforeTyping: false,
    });
    expect(computer.typed).toEqual({
      x: 100,
      y: 200,
      text: 'Hello',
      pressEnter: false,
      clearBeforeTyping: false,
    });
  });

  it('scrolls the document in every direction', async () => {
    const computer = new MockComputer();
    const directions: ScrollDirection[] = ['up', 'down', 'left', 'right'];
    for (const direction of directions) {
      expect(await computer.scrollDocument({direction})).toEqual({
        url: PAGE_URL,
      });
      expect(computer.documentScroll).toEqual({direction});
    }
  });

  it('scrolls at a coordinate by a magnitude', async () => {
    const computer = new MockComputer();
    expect(
      await computer.scrollAt({
        x: 100,
        y: 200,
        direction: 'down',
        magnitude: 5,
      }),
    ).toEqual({url: PAGE_URL});
    expect(computer.pointScroll).toEqual({
      x: 100,
      y: 200,
      direction: 'down',
      magnitude: 5,
    });
  });

  it('waits for a number of seconds', async () => {
    const computer = new MockComputer();
    expect(await computer.wait({seconds: 5})).toEqual({url: PAGE_URL});
    expect(computer.waited).toEqual({seconds: 5});
  });

  it('navigates back in the browser history', async () => {
    expect(await new MockComputer().goBack()).toEqual({url: PAGE_URL});
  });

  it('navigates forward in the browser history', async () => {
    expect(await new MockComputer().goForward()).toEqual({url: PAGE_URL});
  });

  it('jumps to the search engine home page', async () => {
    expect(await new MockComputer().search()).toEqual({url: SEARCH_URL});
  });

  it('navigates to a url', async () => {
    const url = 'https://test.example.com';
    expect(await new MockComputer().navigate({url})).toEqual({url});
  });

  it('presses a key combination', async () => {
    const computer = new MockComputer();
    expect(await computer.keyCombination({keys: ['control', 'c']})).toEqual({
      url: PAGE_URL,
    });
    expect(computer.pressedKeys).toEqual(['control', 'c']);
  });

  it('drags from a source coordinate to a distinct destination', async () => {
    const computer = new MockComputer();
    expect(
      await computer.dragAndDrop({
        x: 100,
        y: 200,
        destinationX: 300,
        destinationY: 400,
      }),
    ).toEqual({url: PAGE_URL});
    expect(computer.dragged).toEqual({
      x: 100,
      y: 200,
      destinationX: 300,
      destinationY: 400,
    });
  });

  it('reports the current state with a screenshot', async () => {
    expect(await new MockComputer().currentState()).toEqual({
      url: PAGE_URL,
      screenshot: SCREENSHOT,
    });
  });

  it('runs the overridden lifecycle hooks in order', async () => {
    const computer = new LifecycleComputer();
    const context = createContext();
    expect(computer.prepared).toBe(false);
    expect(computer.initialized).toBe(false);
    expect(computer.closed).toBe(false);

    await computer.initialize();
    expect(computer.initialized).toBe(true);
    expect(computer.closed).toBe(false);

    await computer.prepare(context);
    expect(computer.prepared).toBe(true);
    expect(computer.preparedFor).toBe(context);

    await computer.close();
    expect(computer.initialized).toBe(true);
    expect(computer.closed).toBe(true);
  });

  it('defaults the three lifecycle hooks to no-ops that resolve', async () => {
    const computer = new MockComputer();

    await computer.prepare(createContext());
    await computer.initialize();
    await computer.close();
  });
});
