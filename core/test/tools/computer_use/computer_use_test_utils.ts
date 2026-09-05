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
  LlmRequest,
  PluginManager,
  ScrollDirection,
  ToolConfirmation,
} from '@google/adk';

/**
 * Builds a tool context backed by a real in-memory session, so a test can
 * assert what a tool recorded on it.
 *
 * @param options.functionCallId The id a confirmation request is keyed by.
 * @param options.toolConfirmation The decision a previous turn already made.
 * @return The tool context.
 */
export function createToolContext(
  options: {
    functionCallId?: string;
    toolConfirmation?: ToolConfirmation;
  } = {},
): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: 'computer_use_agent'}),
      session: createSession({
        id: 'test-session',
        appName: 'computer_use_app',
        userId: 'test-user',
      }),
      pluginManager: new PluginManager([]),
      sessionService: new InMemorySessionService(),
    }),
    functionCallId: options.functionCallId ?? 'test-function-call-id',
    toolConfirmation: options.toolConfirmation,
  });
}

/**
 * Builds an empty outgoing request for a toolset to populate.
 *
 * @param overrides Fields to set on the request, e.g. `allowedTools`.
 * @return The request.
 */
export function createTestLlmRequest(
  overrides: Partial<LlmRequest> = {},
): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}, ...overrides};
}

/** One recorded driver call: the method name and the arguments it received. */
export interface RecordedCall {
  method: string;
  args?: Record<string, unknown>;
}

/**
 * An in-memory {@link BaseComputer} that records what the toolset asked it to
 * do, so a test can assert the wiring of an action without a browser.
 */
export class FakeComputer extends BaseComputer {
  readonly calls: RecordedCall[] = [];
  readonly preparedWith: Context[] = [];
  initializeCount = 0;
  closeCount = 0;
  url = 'https://example.com/current';
  screenshot = new Uint8Array([1, 2, 3]);

  constructor(private readonly size: [number, number] = [1920, 1080]) {
    super();
  }

  override async prepare(context: Context): Promise<void> {
    this.preparedWith.push(context);
  }

  override async initialize(): Promise<void> {
    this.initializeCount++;
  }

  override async close(): Promise<void> {
    this.closeCount++;
  }

  async screenSize(): Promise<[number, number]> {
    return this.size;
  }

  async environment(): Promise<ComputerEnvironment> {
    return ComputerEnvironment.ENVIRONMENT_BROWSER;
  }

  async openWebBrowser(): Promise<ComputerState> {
    return this.record('openWebBrowser');
  }

  async clickAt(args: {x: number; y: number}): Promise<ComputerState> {
    return this.record('clickAt', args);
  }

  async hoverAt(args: {x: number; y: number}): Promise<ComputerState> {
    return this.record('hoverAt', args);
  }

  async typeTextAt(args: {
    x: number;
    y: number;
    text: string;
    pressEnter?: boolean;
    clearBeforeTyping?: boolean;
  }): Promise<ComputerState> {
    return this.record('typeTextAt', args);
  }

  async scrollDocument(args: {
    direction: ScrollDirection;
  }): Promise<ComputerState> {
    return this.record('scrollDocument', args);
  }

  async scrollAt(args: {
    x: number;
    y: number;
    direction: ScrollDirection;
    magnitude: number;
  }): Promise<ComputerState> {
    return this.record('scrollAt', args);
  }

  async wait(args: {seconds: number}): Promise<ComputerState> {
    return this.record('wait', args);
  }

  async goBack(): Promise<ComputerState> {
    return this.record('goBack');
  }

  async goForward(): Promise<ComputerState> {
    return this.record('goForward');
  }

  async search(): Promise<ComputerState> {
    return this.record('search');
  }

  async navigate(args: {url: string}): Promise<ComputerState> {
    this.url = args.url;
    return this.record('navigate', args);
  }

  async keyCombination(args: {keys: string[]}): Promise<ComputerState> {
    return this.record('keyCombination', args);
  }

  async dragAndDrop(args: {
    x: number;
    y: number;
    destinationX: number;
    destinationY: number;
  }): Promise<ComputerState> {
    return this.record('dragAndDrop', args);
  }

  async currentState(): Promise<ComputerState> {
    return this.record('currentState');
  }

  /** The names of the driver methods called so far, in order. */
  methodNames(): string[] {
    return this.calls.map((call) => call.method);
  }

  /** The arguments the named method last received. */
  argsFor(method: string): Record<string, unknown> | undefined {
    return [...this.calls].reverse().find((call) => call.method === method)
      ?.args;
  }

  private record(
    method: string,
    args?: Record<string, unknown>,
  ): ComputerState {
    this.calls.push({method, args});
    return {screenshot: this.screenshot, url: this.url};
  }
}
