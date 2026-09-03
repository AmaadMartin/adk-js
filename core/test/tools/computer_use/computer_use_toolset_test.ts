/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ComputerEnvironment,
  ComputerUseTool,
  ComputerUseToolset,
  LlmRequest,
  isBaseToolset,
  isComputerUseTool,
} from '@google/adk';
import {Environment, Tool} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';

import {
  MOCK_PAGE_URL,
  MockComputer,
  createToolContext,
} from './computer_use_test_utils.js';

// Hoisted so the mock factory and the assertions share one spy, rather than
// casting the overloaded `lookup` signature back to a Mock.
const {lookupMock} = vi.hoisted(() => ({lookupMock: vi.fn()}));

vi.mock('node:dns/promises', () => ({lookup: lookupMock}));

/** Every action the toolset exposes, in the order the model sees them. */
const ALL_FUNCTION_NAMES = [
  'open_web_browser',
  'click_at',
  'hover_at',
  'type_text_at',
  'scroll_document',
  'scroll_at',
  'wait',
  'go_back',
  'go_forward',
  'search',
  'navigate',
  'key_combination',
  'drag_and_drop',
  'current_state',
];

/** A computer reporting an environment outside the enum, as JavaScript can. */
class UnknownEnvironmentComputer extends MockComputer {
  override async environment(): Promise<ComputerEnvironment> {
    const value: string = 'ENVIRONMENT_MOBILE';
    return value as ComputerEnvironment;
  }
}

/** A computer whose initialization fails. */
class FailingComputer extends MockComputer {
  override async initialize(): Promise<void> {
    throw new Error('Initialization failed');
  }
}

function emptyRequest(): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}};
}

function toolNamed(tools: ComputerUseTool[], name: string): ComputerUseTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    expect.fail(`the toolset exposes no ${name} tool`);
  }
  return tool;
}

/** Returns the `navigate` tool of a toolset built over `computer`. */
async function navigateToolOver(
  computer: MockComputer,
  allowPrivateNetworkAccess = false,
): Promise<ComputerUseTool> {
  const toolset = new ComputerUseToolset({computer, allowPrivateNetworkAccess});
  return toolNamed(await toolset.getTools(), 'navigate');
}

/** Reads the computer-use configuration out of a request. */
function computerUseTools(llmRequest: LlmRequest): Tool[] {
  return (llmRequest.config?.tools ?? []).filter(
    (tool): tool is Tool => 'computerUse' in tool && !!tool.computerUse,
  );
}

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{address: '93.184.216.34', family: 4}]);
});

describe('ComputerUseToolset lifecycle', () => {
  it('is a toolset', () => {
    expect(
      isBaseToolset(new ComputerUseToolset({computer: new MockComputer()})),
    ).toBe(true);
  });

  it('initializes the computer when the tools are first requested', async () => {
    const computer = new MockComputer();
    const toolset = new ComputerUseToolset({computer});

    expect(computer.initializeCalled).toBe(0);
    await toolset.getTools();

    expect(computer.initializeCalled).toBe(1);
  });

  it('initializes the computer only once', async () => {
    const computer = new MockComputer();
    const toolset = new ComputerUseToolset({computer});

    await toolset.getTools();
    await toolset.getTools();

    expect(computer.initializeCalled).toBe(1);
  });

  it('initializes the computer once when two callers race', async () => {
    const computer = new MockComputer();
    const toolset = new ComputerUseToolset({computer});

    await Promise.all([toolset.getTools(), toolset.getTools()]);

    expect(computer.initializeCalled).toBe(1);
  });

  it('returns the same tool instances on every call', async () => {
    const toolset = new ComputerUseToolset({computer: new MockComputer()});

    expect(await toolset.getTools()).toBe(await toolset.getTools());
  });

  it('propagates a failing initialization', async () => {
    const toolset = new ComputerUseToolset({computer: new FailingComputer()});

    await expect(toolset.getTools()).rejects.toThrow('Initialization failed');
  });

  it('closes the computer', async () => {
    const computer = new MockComputer();

    await new ComputerUseToolset({computer}).close();

    expect(computer.closeCalled).toBe(1);
  });
});

describe('ComputerUseToolset tools', () => {
  it('exposes every predefined action and no lifecycle method', async () => {
    const toolset = new ComputerUseToolset({computer: new MockComputer()});

    const names = (await toolset.getTools()).map((tool) => tool.name);

    expect(names).toEqual(ALL_FUNCTION_NAMES);
    for (const excluded of ['screen_size', 'environment', 'close', 'prepare']) {
      expect(names).not.toContain(excluded);
    }
    expect(names.every((name) => !name.startsWith('_'))).toBe(true);
  });

  it('gives every tool the real screen size and the default virtual one', async () => {
    const toolset = new ComputerUseToolset({computer: new MockComputer()});

    for (const tool of await toolset.getTools()) {
      expect(isComputerUseTool(tool)).toBe(true);
      expect(tool.screenSize).toEqual({width: 1920, height: 1080});
      expect(tool.virtualScreenSize).toEqual({width: 1000, height: 1000});
    }
  });

  it('carries a custom screen size to every tool', async () => {
    const computer = new MockComputer({
      screenSize: {width: 2560, height: 1440},
    });
    const toolset = new ComputerUseToolset({computer});

    for (const tool of await toolset.getTools()) {
      expect(tool.screenSize).toEqual({width: 2560, height: 1440});
    }
  });

  it('drops the excluded predefined functions and keeps the rest', async () => {
    const toolset = new ComputerUseToolset({
      computer: new MockComputer(),
      excludedPredefinedFunctions: ['drag_and_drop', 'key_combination'],
    });

    const names = (await toolset.getTools()).map((tool) => tool.name);

    expect(names).not.toContain('drag_and_drop');
    expect(names).not.toContain('key_combination');
    expect(names).toContain('click_at');
    expect(names).toHaveLength(ALL_FUNCTION_NAMES.length - 2);
  });

  it('drives the computer through the tool it built', async () => {
    const toolset = new ComputerUseToolset({computer: new MockComputer()});
    const toolContext = createToolContext();

    const result = await toolNamed(
      await toolset.getTools(),
      'click_at',
    ).runAsync({
      args: {x: 500, y: 500},
      toolContext,
    });

    expect(result).toEqual({
      image: {mimetype: 'image/png', data: 'dGVzdA=='},
      url: `${MOCK_PAGE_URL}/click/960/540`,
    });
  });

  it.each([
    ['open_web_browser', {}, ''],
    ['click_at', {x: 500, y: 500}, '/click/960/540'],
    ['hover_at', {x: 500, y: 500}, '/hover/960/540'],
    ['type_text_at', {x: 0, y: 0, text: 'hi'}, '/type/0/0/hi/true/true'],
    ['scroll_document', {direction: 'down'}, '/scroll/down'],
    [
      'scroll_at',
      {x: 0, y: 0, direction: 'up', magnitude: 3},
      '/scroll/0/0/up/3',
    ],
    ['wait', {seconds: 2}, '/wait/2'],
    ['go_back', {}, '/back'],
    ['go_forward', {}, '/forward'],
    ['search', {}, '/search'],
    ['key_combination', {keys: ['control', 'c']}, '/keys/control+c'],
    [
      'drag_and_drop',
      {x: 0, y: 0, destination_x: 1000, destination_y: 1000},
      '/drag/0/0/1919/1079',
    ],
    ['current_state', {}, ''],
  ])('routes %s to the matching computer method', async (name, args, page) => {
    const toolset = new ComputerUseToolset({computer: new MockComputer()});

    const result = await toolNamed(await toolset.getTools(), name).runAsync({
      args,
      toolContext: createToolContext(),
    });

    expect(result).toMatchObject({url: `${MOCK_PAGE_URL}${page}`});
  });

  it('prepares the computer before each action, without passing it the context', async () => {
    const computer = new MockComputer();
    const toolset = new ComputerUseToolset({computer});
    const toolContext = createToolContext();

    const tool = toolNamed(await toolset.getTools(), 'wait');
    await tool.runAsync({args: {seconds: 1}, toolContext});
    await tool.runAsync({args: {seconds: 2}, toolContext});

    expect(computer.prepareCalls).toEqual([toolContext, toolContext]);
  });
});

describe('ComputerUseToolset.processLlmRequest', () => {
  it('registers the tools and configures computer use', async () => {
    const toolset = new ComputerUseToolset({computer: new MockComputer()});
    const llmRequest = emptyRequest();

    await toolset.processLlmRequest(createToolContext(), llmRequest);

    expect(Object.keys(llmRequest.toolsDict)).toEqual(ALL_FUNCTION_NAMES);
    const configured = computerUseTools(llmRequest);
    expect(configured).toHaveLength(1);
    expect(configured[0].computerUse?.environment).toBe(
      Environment.ENVIRONMENT_BROWSER,
    );
    expect(
      configured[0].computerUse?.excludedPredefinedFunctions,
    ).toBeUndefined();
  });

  it('forwards the excluded predefined functions to the model', async () => {
    const toolset = new ComputerUseToolset({
      computer: new MockComputer(),
      excludedPredefinedFunctions: ['drag_and_drop'],
    });
    const llmRequest = emptyRequest();

    await toolset.processLlmRequest(createToolContext(), llmRequest);

    expect(
      computerUseTools(llmRequest)[0].computerUse?.excludedPredefinedFunctions,
    ).toEqual(['drag_and_drop']);
  });

  it('adds no second configuration to a request that already carries one', async () => {
    const toolset = new ComputerUseToolset({computer: new MockComputer()});
    const llmRequest = emptyRequest();
    llmRequest.config = {
      tools: [{computerUse: {environment: Environment.ENVIRONMENT_BROWSER}}],
    };

    await toolset.processLlmRequest(createToolContext(), llmRequest);

    expect(computerUseTools(llmRequest)).toHaveLength(1);
    expect(Object.keys(llmRequest.toolsDict)).toEqual(ALL_FUNCTION_NAMES);
  });

  it('adds no second configuration when called twice', async () => {
    const toolset = new ComputerUseToolset({computer: new MockComputer()});
    const llmRequest = emptyRequest();

    await toolset.processLlmRequest(createToolContext(), llmRequest);
    await toolset.processLlmRequest(createToolContext(), llmRequest);

    expect(computerUseTools(llmRequest)).toHaveLength(1);
  });

  it('keeps a tool the request already carried', async () => {
    const toolset = new ComputerUseToolset({computer: new MockComputer()});
    const llmRequest = emptyRequest();
    llmRequest.config = {tools: [{googleSearch: {}}]};

    await toolset.processLlmRequest(createToolContext(), llmRequest);

    expect(llmRequest.config.tools).toHaveLength(2);
  });

  it('falls back to the browser environment for an unmapped value', async () => {
    const toolset = new ComputerUseToolset({
      computer: new UnknownEnvironmentComputer(),
    });
    const llmRequest = emptyRequest();

    await toolset.processLlmRequest(createToolContext(), llmRequest);

    expect(computerUseTools(llmRequest)[0].computerUse?.environment).toBe(
      Environment.ENVIRONMENT_BROWSER,
    );
  });

  it('rethrows when the computer cannot report its environment', async () => {
    const computer = new MockComputer();
    vi.spyOn(computer, 'environment').mockRejectedValue(
      new Error('Environment failed'),
    );
    const toolset = new ComputerUseToolset({computer});

    await expect(
      toolset.processLlmRequest(createToolContext(), emptyRequest()),
    ).rejects.toThrow('Environment failed');
  });
});

describe('ComputerUseToolset.adaptComputerUseTool', () => {
  async function requestWithWaitTool(): Promise<LlmRequest> {
    const toolset = new ComputerUseToolset({computer: new MockComputer()});
    const llmRequest = emptyRequest();
    await toolset.processLlmRequest(createToolContext(), llmRequest);
    return llmRequest;
  }

  it('swaps the tool a synchronous adapter replaces', async () => {
    const llmRequest = await requestWithWaitTool();

    await ComputerUseToolset.adaptComputerUseTool(
      'wait',
      (original) => ({
        name: 'wait_five',
        execute: () => original({seconds: 5}),
      }),
      llmRequest,
    );

    expect(llmRequest.toolsDict['wait']).toBeUndefined();
    const adapted = llmRequest.toolsDict['wait_five'];
    expect(isComputerUseTool(adapted)).toBe(true);
    if (!isComputerUseTool(adapted)) {
      expect.fail('the adapted tool is not a computer-use tool');
    }
    expect(adapted.screenSize).toEqual({width: 1920, height: 1080});
    expect(adapted.virtualScreenSize).toEqual({width: 1000, height: 1000});
  });

  it('swaps the tool an asynchronous adapter replaces', async () => {
    const llmRequest = await requestWithWaitTool();

    await ComputerUseToolset.adaptComputerUseTool(
      'wait',
      async (original) => ({
        name: 'wait_five',
        execute: () => original({seconds: 5}),
      }),
      llmRequest,
    );

    expect(llmRequest.toolsDict['wait']).toBeUndefined();
    expect(llmRequest.toolsDict['wait_five']).toBeDefined();
  });

  it('runs the adapted function in place of the original', async () => {
    const llmRequest = await requestWithWaitTool();

    await ComputerUseToolset.adaptComputerUseTool(
      'wait',
      (original) => ({
        name: 'wait_five',
        parameters: z.object({}),
        execute: () => original({seconds: 5}),
      }),
      llmRequest,
    );

    const result = await llmRequest.toolsDict['wait_five'].runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({
      image: {mimetype: 'image/png', data: 'dGVzdA=='},
      url: `${MOCK_PAGE_URL}/wait/5`,
    });
  });

  it('inherits the description and the schema of the original tool', async () => {
    const llmRequest = await requestWithWaitTool();
    const originalDeclaration = llmRequest.toolsDict['wait']._getDeclaration();

    await ComputerUseToolset.adaptComputerUseTool(
      'wait',
      (original) => ({
        name: 'wait_five',
        execute: () => original({seconds: 5}),
      }),
      llmRequest,
    );

    const adapted = llmRequest.toolsDict['wait_five']._getDeclaration();
    expect(adapted?.description).toBe(originalDeclaration?.description);
    expect(adapted?.parameters).toEqual(originalDeclaration?.parameters);
  });

  it.each([
    ['screen_size', 'a lifecycle method'],
    ['not_a_method', 'an unknown method'],
    ['wait', 'a method that is not registered'],
  ])('leaves the request untouched for %s', async (methodName) => {
    const llmRequest = emptyRequest();

    await ComputerUseToolset.adaptComputerUseTool(
      methodName,
      () => ({name: 'replacement', execute: async () => undefined}),
      llmRequest,
    );

    expect(llmRequest.toolsDict).toEqual({});
  });

  it('leaves the request untouched when the adapter returns an unnamed tool', async () => {
    const llmRequest = await requestWithWaitTool();

    await ComputerUseToolset.adaptComputerUseTool(
      'wait',
      () => ({name: '', execute: async () => undefined}),
      llmRequest,
    );

    expect(llmRequest.toolsDict['wait']).toBeDefined();
    expect(Object.keys(llmRequest.toolsDict)).toEqual(ALL_FUNCTION_NAMES);
  });
});

describe('navigate url safety', () => {
  it.each([
    [
      'the cloud metadata service',
      'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token',
    ],
    ['a backslash authority', 'http://169.254.169.254\\@example.com/'],
    ['a non-http scheme', 'file:///etc/passwd'],
    ['localhost', 'http://localhost:3000/'],
  ])(
    'refuses %s without resolving it or driving the browser',
    async (_case, url) => {
      const computer = new MockComputer();
      const navigateTool = await navigateToolOver(computer);

      const result = await navigateTool.func({url});

      expect(computer.navigateCalls).toEqual([]);
      expect(lookupMock).not.toHaveBeenCalled();
      expect(result).toEqual({
        error:
          'navigate refused: url must be http(s) and must not target a private' +
          ' or link-local address.',
        url: MOCK_PAGE_URL,
      });
    },
  );

  it.each([
    ['no arguments object', 'nope'],
    ['no url key', {}],
    ['a url that is not a string', {url: 5}],
  ])('refuses a call carrying %s', async (_case, args) => {
    const computer = new MockComputer();
    const navigateTool = await navigateToolOver(computer);

    const result = await navigateTool.func(args);

    expect(computer.navigateCalls).toEqual([]);
    expect(result).toMatchObject({url: MOCK_PAGE_URL});
  });

  it('accepts a public url that has no path', async () => {
    const computer = new MockComputer();
    const navigateTool = await navigateToolOver(computer);

    await navigateTool.func({url: 'https://example.com'});

    expect(computer.navigateCalls).toEqual(['https://example.com']);
  });

  it('passes a public url to the browser exactly as the model wrote it', async () => {
    const computer = new MockComputer();
    const navigateTool = await navigateToolOver(computer);

    const result = await navigateTool.func({
      url: 'https://example.com/search?q=adk',
    });

    expect(computer.navigateCalls).toEqual([
      'https://example.com/search?q=adk',
    ]);
    expect(result).toMatchObject({url: 'https://example.com/search?q=adk'});
    expect(lookupMock).toHaveBeenCalledOnce();
  });

  it('refuses a public host that resolves to a private address', async () => {
    lookupMock.mockResolvedValue([{address: '10.0.0.1', family: 4}]);
    const computer = new MockComputer();
    const navigateTool = await navigateToolOver(computer);

    const result = await navigateTool.func({url: 'https://internal.test/'});

    expect(computer.navigateCalls).toEqual([]);
    expect(lookupMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({url: MOCK_PAGE_URL});
  });

  // `localhost` is the host a local dev server actually runs on, and it is
  // rejected by the hostname check rather than by address resolution. Both
  // checks have to be skipped together, or the escape hatch does not open.
  it.each([
    ['a loopback address', 'http://127.0.0.1:8000/'],
    ['localhost', 'http://localhost:3000/'],
    ['a localhost subdomain', 'http://dev.localhost/'],
  ])(
    'reaches %s when private network access is allowed',
    async (_case, url) => {
      const computer = new MockComputer();
      const navigateTool = await navigateToolOver(computer, true);

      const result = await navigateTool.func({url});

      expect(computer.navigateCalls).toEqual([url]);
      expect(result).toMatchObject({url});
      expect(lookupMock).not.toHaveBeenCalled();
    },
  );

  it('still refuses a non-http scheme when private network access is allowed', async () => {
    const computer = new MockComputer();
    const navigateTool = await navigateToolOver(computer, true);

    const result = await navigateTool.func({url: 'file:///etc/passwd'});

    expect(computer.navigateCalls).toEqual([]);
    expect(result).toMatchObject({url: MOCK_PAGE_URL});
  });

  it('still prepares the computer for a permitted url', async () => {
    const computer = new MockComputer();
    const navigateTool = await navigateToolOver(computer);
    const toolContext = createToolContext();

    const result = await navigateTool.runAsync({
      args: {url: 'https://example.com/'},
      toolContext,
    });

    expect(computer.prepareCalls).toEqual([toolContext]);
    expect(computer.navigateCalls).toEqual(['https://example.com/']);
    expect(result).toMatchObject({url: 'https://example.com/'});
  });
});
