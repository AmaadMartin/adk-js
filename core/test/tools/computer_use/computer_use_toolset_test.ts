/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LookupAddress} from 'node:dns';

import {
  BaseComputer,
  ComputerEnvironment,
  ComputerState,
  ComputerUseTool,
  ComputerUseToolset,
  Context,
  createSession,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  URL_REFUSED_ERROR,
} from '@google/adk';
import {Environment, Tool} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';

// Declaring the mock ahead of `vi.mock` pins it to the single `{all: true}`
// overload the implementation uses, so it stays typed without a cast.
const {lookupMock} = vi.hoisted(() => ({
  lookupMock:
    vi.fn<
      (hostname: string, options: {all: true}) => Promise<LookupAddress[]>
    >(),
}));

vi.mock('node:dns/promises', () => ({lookup: lookupMock}));

const CURRENT_URL = 'https://already-here.example.com/';

/** A driver that records every call the toolset makes. */
class MockComputer extends BaseComputer {
  readonly calls: Array<{method: string; args?: unknown}> = [];
  initializeCount = 0;
  closeCount = 0;
  prepareCount = 0;
  initializeError?: Error;
  environmentError?: Error;
  environmentValue: ComputerEnvironment =
    ComputerEnvironment.ENVIRONMENT_BROWSER;

  constructor(readonly size: [number, number] = [1920, 1080]) {
    super();
  }

  override async prepare(_context: Context): Promise<void> {
    this.prepareCount += 1;
  }
  override async initialize(): Promise<void> {
    this.initializeCount += 1;
    if (this.initializeError) {
      throw this.initializeError;
    }
  }
  override async close(): Promise<void> {
    this.closeCount += 1;
  }
  async screenSize(): Promise<[number, number]> {
    return this.size;
  }
  async environment(): Promise<ComputerEnvironment> {
    if (this.environmentError) {
      throw this.environmentError;
    }
    return this.environmentValue;
  }

  private record(method: string, args?: unknown): ComputerState {
    this.calls.push({method, args});
    return {url: CURRENT_URL};
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
  async typeTextAt(args: unknown): Promise<ComputerState> {
    return this.record('typeTextAt', args);
  }
  async scrollDocument(args: unknown): Promise<ComputerState> {
    return this.record('scrollDocument', args);
  }
  async scrollAt(args: unknown): Promise<ComputerState> {
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
    return this.record('navigate', args);
  }
  async keyCombination(args: {keys: string[]}): Promise<ComputerState> {
    return this.record('keyCombination', args);
  }
  async dragAndDrop(args: unknown): Promise<ComputerState> {
    return this.record('dragAndDrop', args);
  }
  async currentState(): Promise<ComputerState> {
    return this.record('currentState');
  }

  /** The calls the driver received for one method. */
  callsTo(method: string): unknown[] {
    return this.calls.filter((call) => call.method === method);
  }
}

const ALL_TOOL_NAMES = [
  'click_at',
  'current_state',
  'drag_and_drop',
  'go_back',
  'go_forward',
  'hover_at',
  'key_combination',
  'navigate',
  'open_web_browser',
  'screenshot_placeholder',
  'scroll_at',
  'scroll_document',
  'search',
  'type_text_at',
  'wait',
].filter((name) => name !== 'screenshot_placeholder');

/** Builds a `Context` a tool can run against. */
function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      agent: new LlmAgent({name: 'computer_agent'}),
      session: createSession({id: 's1', appName: 'app', userId: 'u1'}),
      pluginManager: new PluginManager([]),
      sessionService: new InMemorySessionService(),
    }),
    functionCallId: 'call-1',
  });
}

/** Builds an empty outgoing request. */
function emptyRequest(): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}};
}

/** Resolves any hostname to the given IP list for the DNS `lookup` mock. */
function resolveTo(...addresses: string[]): void {
  lookupMock.mockResolvedValue(
    addresses.map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    })),
  );
}

/** Finds a tool by its wire name, failing the test when it is absent. */
async function toolNamed(
  toolset: ComputerUseToolset,
  name: string,
): Promise<ComputerUseTool> {
  const tool = (await toolset.getTools()).find((t) => t.name === name);
  if (!tool) {
    return expect.fail(`tool ${name} not found`);
  }
  return tool;
}

describe('ComputerUseToolset.getTools', () => {
  it('initializes the computer once across repeated calls', async () => {
    const computer = new MockComputer();
    const toolset = new ComputerUseToolset({computer});

    const first = await toolset.getTools();
    const second = await toolset.getTools();

    expect(computer.initializeCount).toBe(1);
    expect(second).toBe(first);
  });

  it('does not double-initialize when callers race', async () => {
    const computer = new MockComputer();
    const toolset = new ComputerUseToolset({computer});

    await Promise.all([toolset.getTools(), toolset.getTools()]);

    expect(computer.initializeCount).toBe(1);
  });

  it('exposes exactly the fourteen predefined function names', async () => {
    const toolset = new ComputerUseToolset({computer: new MockComputer()});

    const names = (await toolset.getTools()).map((tool) => tool.name).sort();

    expect(names).toEqual(ALL_TOOL_NAMES);
    expect(names).toHaveLength(14);
  });

  it('exposes no tool for a lifecycle or introspection method', async () => {
    const toolset = new ComputerUseToolset({computer: new MockComputer()});

    const names = (await toolset.getTools()).map((tool) => tool.name);

    for (const excluded of [
      'screen_size',
      'screenSize',
      'environment',
      'close',
      'prepare',
      'initialize',
    ]) {
      expect(names).not.toContain(excluded);
    }
  });

  it('withholds the excluded predefined functions', async () => {
    const toolset = new ComputerUseToolset({
      computer: new MockComputer(),
      excludedPredefinedFunctions: ['drag_and_drop', 'key_combination'],
    });

    const names = (await toolset.getTools()).map((tool) => tool.name);

    expect(names).not.toContain('drag_and_drop');
    expect(names).not.toContain('key_combination');
    expect(names).toContain('click_at');
    expect(names).toHaveLength(12);
  });

  it('gives every tool the computer’s screen size', async () => {
    const computer = new MockComputer([800, 600]);
    const toolset = new ComputerUseToolset({computer});
    const tool = await toolNamed(toolset, 'click_at');

    await tool.runAsync({
      args: {x: 500, y: 500},
      toolContext: createToolContext(),
    });

    expect(computer.calls[0]).toEqual({
      method: 'clickAt',
      args: {x: 400, y: 300},
    });
  });

  it('propagates an initialize() that rejects', async () => {
    const computer = new MockComputer();
    computer.initializeError = new Error('no display');
    const toolset = new ComputerUseToolset({computer});

    await expect(toolset.getTools()).rejects.toThrow('no display');
  });

  it('prepares the computer before each action', async () => {
    const computer = new MockComputer();
    const toolset = new ComputerUseToolset({computer});
    const tool = await toolNamed(toolset, 'go_back');

    await tool.runAsync({args: {}, toolContext: createToolContext()});

    expect(computer.prepareCount).toBe(1);
    expect(computer.calls[0].method).toBe('goBack');
  });

  it('maps the snake_case wire arguments onto the camelCase driver options', async () => {
    const computer = new MockComputer();
    const toolset = new ComputerUseToolset({computer});
    const typeText = await toolNamed(toolset, 'type_text_at');
    const drag = await toolNamed(toolset, 'drag_and_drop');

    await typeText.runAsync({
      args: {x: 0, y: 0, text: 'hi', press_enter: false},
      toolContext: createToolContext(),
    });
    await drag.runAsync({
      args: {x: 0, y: 0, destination_x: 1000, destination_y: 1000},
      toolContext: createToolContext(),
    });

    expect(computer.calls[0].args).toEqual({
      x: 0,
      y: 0,
      text: 'hi',
      pressEnter: false,
      clearBeforeTyping: undefined,
    });
    expect(computer.calls[1].args).toEqual({
      x: 0,
      y: 0,
      destinationX: 1919,
      destinationY: 1079,
    });
  });

  it('rejects an argument the model sent with the wrong type', async () => {
    const toolset = new ComputerUseToolset({computer: new MockComputer()});
    const tool = await toolNamed(toolset, 'wait');

    await expect(
      tool.runAsync({
        args: {seconds: 'soon'},
        toolContext: createToolContext(),
      }),
    ).rejects.toThrow();
  });
});

describe('ComputerUseToolset action space', () => {
  beforeEach(() => {
    lookupMock.mockReset();
    resolveTo('93.184.216.34');
  });

  // Pins every wire name to the driver method it drives. A mapping mistake
  // here is invisible in review and silently gives the model a dead action.
  it.each([
    ['open_web_browser', {}, 'openWebBrowser'],
    ['click_at', {x: 0, y: 0}, 'clickAt'],
    ['hover_at', {x: 0, y: 0}, 'hoverAt'],
    ['type_text_at', {x: 0, y: 0, text: 'hi'}, 'typeTextAt'],
    ['scroll_document', {direction: 'down'}, 'scrollDocument'],
    ['scroll_at', {x: 0, y: 0, direction: 'up', magnitude: 3}, 'scrollAt'],
    ['wait', {seconds: 2}, 'wait'],
    ['go_back', {}, 'goBack'],
    ['go_forward', {}, 'goForward'],
    ['search', {}, 'search'],
    ['navigate', {url: 'https://example.com/'}, 'navigate'],
    ['key_combination', {keys: ['control', 'c']}, 'keyCombination'],
    [
      'drag_and_drop',
      {x: 0, y: 0, destination_x: 1, destination_y: 1},
      'dragAndDrop',
    ],
    ['current_state', {}, 'currentState'],
  ])('routes %s to the driver', async (wireName, args, method) => {
    const computer = new MockComputer();
    const toolset = new ComputerUseToolset({computer});
    const tool = await toolNamed(toolset, wireName);

    await tool.runAsync({args, toolContext: createToolContext()});

    expect(computer.callsTo(method)).toHaveLength(1);
  });
});

describe('ComputerUseToolset.close', () => {
  it('closes the computer', async () => {
    const computer = new MockComputer();

    await new ComputerUseToolset({computer}).close();

    expect(computer.closeCount).toBe(1);
  });
});

describe('ComputerUseToolset.processLlmRequest', () => {
  it('registers every tool and appends one computerUse entry', async () => {
    const toolset = new ComputerUseToolset({computer: new MockComputer()});
    const llmRequest = emptyRequest();

    await toolset.processLlmRequest(createToolContext(), llmRequest);

    expect(Object.keys(llmRequest.toolsDict).sort()).toEqual(ALL_TOOL_NAMES);
    expect(llmRequest.config?.tools).toEqual([
      {computerUse: {environment: 'ENVIRONMENT_BROWSER'}},
    ]);
  });

  it('forwards the exclusions to the API verbatim', async () => {
    const toolset = new ComputerUseToolset({
      computer: new MockComputer(),
      excludedPredefinedFunctions: ['drag_and_drop'],
    });
    const llmRequest = emptyRequest();

    await toolset.processLlmRequest(createToolContext(), llmRequest);

    expect(llmRequest.config?.tools?.[0]).toEqual({
      computerUse: {
        environment: 'ENVIRONMENT_BROWSER',
        excludedPredefinedFunctions: ['drag_and_drop'],
      },
    });
  });

  it('reports ENVIRONMENT_UNSPECIFIED when the driver returns it', async () => {
    const computer = new MockComputer();
    computer.environmentValue = ComputerEnvironment.ENVIRONMENT_UNSPECIFIED;
    const llmRequest = emptyRequest();

    await new ComputerUseToolset({computer}).processLlmRequest(
      createToolContext(),
      llmRequest,
    );

    expect(llmRequest.config?.tools?.[0]).toEqual({
      computerUse: {environment: 'ENVIRONMENT_UNSPECIFIED'},
    });
  });

  it('does not append a second computerUse entry, but still registers tools', async () => {
    const toolset = new ComputerUseToolset({computer: new MockComputer()});
    const existing: Tool = {
      computerUse: {environment: Environment.ENVIRONMENT_BROWSER},
    };
    const llmRequest = emptyRequest();
    llmRequest.config = {tools: [existing]};

    await toolset.processLlmRequest(createToolContext(), llmRequest);

    expect(llmRequest.config.tools).toEqual([existing]);
    expect(Object.keys(llmRequest.toolsDict)).toHaveLength(14);
  });

  it('appends alongside an unrelated tool entry', async () => {
    const toolset = new ComputerUseToolset({computer: new MockComputer()});
    const llmRequest = emptyRequest();
    llmRequest.config = {tools: [{googleSearch: {}}]};

    await toolset.processLlmRequest(createToolContext(), llmRequest);

    expect(llmRequest.config.tools).toHaveLength(2);
  });

  it('propagates an environment() that rejects', async () => {
    const computer = new MockComputer();
    computer.environmentError = new Error('driver gone');

    await expect(
      new ComputerUseToolset({computer}).processLlmRequest(
        createToolContext(),
        emptyRequest(),
      ),
    ).rejects.toThrow('driver gone');
  });
});

describe('ComputerUseToolset navigate url safety', () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it.each([
    [
      'the cloud metadata address',
      'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token',
    ],
    ['a backslash in the authority', 'http://169.254.169.254\\@example.com/'],
    ['a file: url', 'file:///etc/passwd'],
    ['a localhost url', 'http://localhost:3000/'],
  ])('refuses %s before the driver and before any lookup', async (_, url) => {
    const computer = new MockComputer();
    const toolset = new ComputerUseToolset({computer});
    const navigate = await toolNamed(toolset, 'navigate');

    const result = await navigate.runAsync({
      args: {url},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({error: URL_REFUSED_ERROR, url: CURRENT_URL});
    expect(computer.callsTo('navigate')).toHaveLength(0);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('refuses a public hostname that resolves to a private address', async () => {
    resolveTo('10.0.0.5');
    const computer = new MockComputer();
    const toolset = new ComputerUseToolset({computer});
    const navigate = await toolNamed(toolset, 'navigate');

    const result = await navigate.runAsync({
      args: {url: 'https://rebind.example.com/'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({error: URL_REFUSED_ERROR, url: CURRENT_URL});
    expect(computer.callsTo('navigate')).toHaveLength(0);
    expect(lookupMock).toHaveBeenCalledOnce();
  });

  it('passes a public url to the driver byte-identical, after a lookup', async () => {
    resolveTo('93.184.216.34');
    const computer = new MockComputer();
    const toolset = new ComputerUseToolset({computer});
    const navigate = await toolNamed(toolset, 'navigate');

    await navigate.runAsync({
      args: {url: 'https://example.com/search?q=adk'},
      toolContext: createToolContext(),
    });

    expect(computer.calls[0]).toEqual({
      method: 'navigate',
      args: {url: 'https://example.com/search?q=adk'},
    });
    expect(lookupMock).toHaveBeenCalledOnce();
  });

  it('reaches a private host with allowPrivateNetworkAccess, without a lookup', async () => {
    const computer = new MockComputer();
    const toolset = new ComputerUseToolset({
      computer,
      allowPrivateNetworkAccess: true,
    });
    const navigate = await toolNamed(toolset, 'navigate');

    await navigate.runAsync({
      args: {url: 'http://127.0.0.1:8000/'},
      toolContext: createToolContext(),
    });

    expect(computer.calls[0]).toEqual({
      method: 'navigate',
      args: {url: 'http://127.0.0.1:8000/'},
    });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('still refuses a non-http scheme with allowPrivateNetworkAccess', async () => {
    const computer = new MockComputer();
    const toolset = new ComputerUseToolset({
      computer,
      allowPrivateNetworkAccess: true,
    });
    const navigate = await toolNamed(toolset, 'navigate');

    const result = await navigate.runAsync({
      args: {url: 'file:///etc/passwd'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({error: URL_REFUSED_ERROR, url: CURRENT_URL});
    expect(computer.callsTo('navigate')).toHaveLength(0);
  });

  it('still prepares the computer for a navigate call', async () => {
    resolveTo('93.184.216.34');
    const computer = new MockComputer();
    const toolset = new ComputerUseToolset({computer});
    const navigate = await toolNamed(toolset, 'navigate');

    await navigate.runAsync({
      args: {url: 'https://example.com/'},
      toolContext: createToolContext(),
    });

    expect(computer.prepareCount).toBe(1);
  });
});

describe('ComputerUseToolset.adaptComputerUseTool', () => {
  /** Registers the toolset's tools on a fresh request. */
  async function requestWithTools(
    toolset: ComputerUseToolset,
  ): Promise<LlmRequest> {
    const llmRequest = emptyRequest();
    await toolset.processLlmRequest(createToolContext(), llmRequest);
    return llmRequest;
  }

  it('replaces the entry and carries the screen sizes over', async () => {
    const computer = new MockComputer([800, 600]);
    const toolset = new ComputerUseToolset({computer});
    const llmRequest = await requestWithTools(toolset);

    await ComputerUseToolset.adaptComputerUseTool({
      name: 'wait',
      llmRequest,
      adapt: (tool) =>
        new ComputerUseTool({
          name: 'wait_5_seconds',
          description: 'Waits five seconds.',
          parameters: z.object({}),
          screenSize: tool.screenSize,
          virtualScreenSize: tool.virtualScreenSize,
          invoke: () => computer.wait({seconds: 5}),
        }),
    });

    expect(llmRequest.toolsDict).not.toHaveProperty('wait');
    const adapted = llmRequest.toolsDict['wait_5_seconds'];
    expect(adapted).toBeInstanceOf(ComputerUseTool);
    expect((adapted as ComputerUseTool).screenSize).toEqual([800, 600]);
    expect((adapted as ComputerUseTool).virtualScreenSize).toEqual([
      1000, 1000,
    ]);

    await adapted.runAsync({args: {}, toolContext: createToolContext()});
    expect(computer.calls[0]).toEqual({method: 'wait', args: {seconds: 5}});
  });

  it('accepts an async adapt callback', async () => {
    const toolset = new ComputerUseToolset({computer: new MockComputer()});
    const llmRequest = await requestWithTools(toolset);

    await ComputerUseToolset.adaptComputerUseTool({
      name: 'search',
      llmRequest,
      adapt: async (tool) =>
        new ComputerUseTool({
          name: 'search_now',
          description: 'Searches.',
          parameters: z.object({}),
          screenSize: tool.screenSize,
          invoke: async () => ({}),
        }),
    });

    expect(llmRequest.toolsDict).not.toHaveProperty('search');
    expect(llmRequest.toolsDict).toHaveProperty('search_now');
  });

  it('leaves toolsDict untouched for an unknown action name', async () => {
    const toolset = new ComputerUseToolset({computer: new MockComputer()});
    const llmRequest = await requestWithTools(toolset);
    const before = Object.keys(llmRequest.toolsDict).sort();

    await ComputerUseToolset.adaptComputerUseTool({
      name: 'teleport',
      llmRequest,
      adapt: () => expect.fail('adapt must not run'),
    });

    expect(Object.keys(llmRequest.toolsDict).sort()).toEqual(before);
  });

  it('leaves toolsDict untouched for an excluded action name', async () => {
    const toolset = new ComputerUseToolset({
      computer: new MockComputer(),
      excludedPredefinedFunctions: ['wait'],
    });
    const llmRequest = await requestWithTools(toolset);
    const before = Object.keys(llmRequest.toolsDict).sort();

    await ComputerUseToolset.adaptComputerUseTool({
      name: 'wait',
      llmRequest,
      adapt: () => expect.fail('adapt must not run'),
    });

    expect(Object.keys(llmRequest.toolsDict).sort()).toEqual(before);
  });

  it('leaves toolsDict untouched when the name is absent from it', async () => {
    const llmRequest = emptyRequest();

    await ComputerUseToolset.adaptComputerUseTool({
      name: 'wait',
      llmRequest,
      adapt: () => expect.fail('adapt must not run'),
    });

    expect(llmRequest.toolsDict).toEqual({});
  });
});
