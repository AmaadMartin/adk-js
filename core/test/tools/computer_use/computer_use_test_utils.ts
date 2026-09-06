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
  LlmAgent,
  PluginManager,
  ScreenSize,
  ScrollDirection,
  ToolConfirmation,
  createSession,
} from '@google/adk';

/** The screenshot bytes every mock action returns. */
export const MOCK_SCREENSHOT = new TextEncoder().encode('test');

/** The page the mock browser sits on before anything navigates it. */
export const MOCK_PAGE_URL = 'https://example.com';

/** Builds the state a mock action returns. */
function state(url = MOCK_PAGE_URL): ComputerState {
  return {screenshot: MOCK_SCREENSHOT, url};
}

/** Options for a {@link MockComputer}. */
export interface MockComputerOptions {
  screenSize?: ScreenSize;
  environment?: ComputerEnvironment;
}

/**
 * A concrete {@link BaseComputer} that records what the toolset asked it to
 * do, so a test can assert on the driver calls it did and did not make.
 */
export class MockComputer extends BaseComputer {
  initializeCalled = 0;
  closeCalled = 0;
  readonly navigateCalls: string[] = [];
  readonly prepareCalls: Context[] = [];

  private readonly size: ScreenSize;
  private readonly computerEnvironment: ComputerEnvironment;

  constructor(options: MockComputerOptions = {}) {
    super();
    this.size = options.screenSize ?? {width: 1920, height: 1080};
    this.computerEnvironment =
      options.environment ?? ComputerEnvironment.ENVIRONMENT_BROWSER;
  }

  override async prepare(toolContext: Context): Promise<void> {
    this.prepareCalls.push(toolContext);
  }

  override async initialize(): Promise<void> {
    this.initializeCalled++;
  }

  override async close(): Promise<void> {
    this.closeCalled++;
  }

  async screenSize(): Promise<ScreenSize> {
    return this.size;
  }

  async environment(): Promise<ComputerEnvironment> {
    return this.computerEnvironment;
  }

  async openWebBrowser(): Promise<ComputerState> {
    return state();
  }

  async clickAt(x: number, y: number): Promise<ComputerState> {
    return state(`${MOCK_PAGE_URL}/click/${x}/${y}`);
  }

  async hoverAt(x: number, y: number): Promise<ComputerState> {
    return state(`${MOCK_PAGE_URL}/hover/${x}/${y}`);
  }

  async typeTextAt(
    x: number,
    y: number,
    text: string,
    pressEnter?: boolean,
    clearBeforeTyping?: boolean,
  ): Promise<ComputerState> {
    return state(
      `${MOCK_PAGE_URL}/type/${x}/${y}/${text}/${pressEnter}/${clearBeforeTyping}`,
    );
  }

  async scrollDocument(direction: ScrollDirection): Promise<ComputerState> {
    return state(`${MOCK_PAGE_URL}/scroll/${direction}`);
  }

  async scrollAt(
    x: number,
    y: number,
    direction: ScrollDirection,
    magnitude: number,
  ): Promise<ComputerState> {
    return state(`${MOCK_PAGE_URL}/scroll/${x}/${y}/${direction}/${magnitude}`);
  }

  async wait(seconds: number): Promise<ComputerState> {
    return state(`${MOCK_PAGE_URL}/wait/${seconds}`);
  }

  async goBack(): Promise<ComputerState> {
    return state(`${MOCK_PAGE_URL}/back`);
  }

  async goForward(): Promise<ComputerState> {
    return state(`${MOCK_PAGE_URL}/forward`);
  }

  async search(): Promise<ComputerState> {
    return state(`${MOCK_PAGE_URL}/search`);
  }

  async navigate(url: string): Promise<ComputerState> {
    this.navigateCalls.push(url);
    return state(url);
  }

  async keyCombination(keys: string[]): Promise<ComputerState> {
    return state(`${MOCK_PAGE_URL}/keys/${keys.join('+')}`);
  }

  async dragAndDrop(
    x: number,
    y: number,
    destinationX: number,
    destinationY: number,
  ): Promise<ComputerState> {
    return state(
      `${MOCK_PAGE_URL}/drag/${x}/${y}/${destinationX}/${destinationY}`,
    );
  }

  async currentState(): Promise<ComputerState> {
    return state();
  }
}

/** Builds a tool context a computer-use tool can be run with. */
export function createToolContext(
  options: {
    functionCallId?: string;
    toolConfirmation?: ToolConfirmation;
  } = {},
): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'computer_agent', model: 'gemini-2.5-flash'}),
    session: createSession({id: 's1', appName: 'app', userId: 'u1'}),
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext, ...options});
}
