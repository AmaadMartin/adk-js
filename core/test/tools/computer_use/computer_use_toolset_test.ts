/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {lookup} from 'node:dns/promises';

import {
  ComputerEnvironment,
  ComputerUseTool,
  ComputerUseToolset,
  Context,
  isComputerUseTool,
  LlmRequest,
  URL_REFUSED_ERROR,
} from '@google/adk';
import {Environment} from '@google/genai';
import {beforeEach, describe, expect, it, Mock, vi} from 'vitest';

import {
  createTestLlmRequest,
  createToolContext,
  FakeComputer,
} from './computer_use_test_utils.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

// `lookup` is overloaded; treat the mock as a plain Mock so `mockResolvedValue`
// accepts the `{all: true}` array-return shape used by the implementation.
const lookupMock = lookup as unknown as Mock;

/** The 14 predefined computer-use functions, in the order they are declared. */
const ACTION_NAMES = [
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

/** Resolves any hostname to the given IP list for the DNS `lookup` mock. */
function resolveTo(...addresses: string[]): void {
  lookupMock.mockResolvedValue(
    addresses.map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    })),
  );
}

/** Runs one action of the toolset by its wire name. */
async function runAction(
  toolset: ComputerUseToolset,
  name: string,
  args: Record<string, unknown> = {},
  toolContext: Context = createToolContext(),
): Promise<unknown> {
  const tool = (await toolset.getTools()).find((each) => each.name === name);
  if (!tool) {
    expect.fail(`the toolset exposes no action named ${name}`);
  }
  return tool.runAsync({args, toolContext});
}

describe('ComputerUseToolset getTools', () => {
  beforeEach(() => {
    lookupMock.mockReset();
    resolveTo('93.184.216.34');
  });

  it('exposes exactly the predefined action space', async () => {
    const tools = await new ComputerUseToolset({
      computer: new FakeComputer(),
    }).getTools();

    expect(tools.map((tool) => tool.name)).toEqual(ACTION_NAMES);
    expect(tools.every(isComputerUseTool)).toBe(true);
  });

  it.each(['screen_size', 'environment', 'close', 'prepare', 'initialize'])(
    'does not expose the %s lifecycle method',
    async (name) => {
      const tools = await new ComputerUseToolset({
        computer: new FakeComputer(),
      }).getTools();

      expect(tools.map((tool) => tool.name)).not.toContain(name);
    },
  );

  it('initializes the driver once and returns the same tools', async () => {
    const computer = new FakeComputer();
    const toolset = new ComputerUseToolset({computer});

    const first = await toolset.getTools();
    const second = await toolset.getTools();

    expect(second).toBe(first);
    expect(computer.initializeCount).toBe(1);
  });

  it('initializes the driver once under concurrent callers', async () => {
    const computer = new FakeComputer();
    const toolset = new ComputerUseToolset({computer});

    const [first, second] = await Promise.all([
      toolset.getTools(),
      toolset.getTools(),
    ]);

    expect(second).toBe(first);
    expect(computer.initializeCount).toBe(1);
  });

  it('drops the excluded functions and keeps the rest', async () => {
    const toolset = new ComputerUseToolset({
      computer: new FakeComputer(),
      excludedPredefinedFunctions: ['drag_and_drop', 'key_combination'],
    });

    const names = (await toolset.getTools()).map((tool) => tool.name);

    expect(names).not.toContain('drag_and_drop');
    expect(names).not.toContain('key_combination');
    expect(names).toContain('click_at');
    expect(names).toHaveLength(ACTION_NAMES.length - 2);
  });

  it('gives every tool the size the driver reported', async () => {
    const toolset = new ComputerUseToolset({
      computer: new FakeComputer([2560, 1440]),
    });

    for (const tool of await toolset.getTools()) {
      expect(tool.screenSize).toEqual([2560, 1440]);
    }
  });

  it('surfaces an error the driver raised while initializing', async () => {
    const computer = new FakeComputer();
    vi.spyOn(computer, 'initialize').mockRejectedValue(
      new Error('sandbox unavailable'),
    );

    await expect(new ComputerUseToolset({computer}).getTools()).rejects.toThrow(
      'sandbox unavailable',
    );
  });
});

describe('ComputerUseToolset close', () => {
  it('closes the driver', async () => {
    const computer = new FakeComputer();

    await new ComputerUseToolset({computer}).close();

    expect(computer.closeCount).toBe(1);
  });
});

describe('ComputerUseToolset action dispatch', () => {
  let computer: FakeComputer;
  let toolset: ComputerUseToolset;

  beforeEach(() => {
    lookupMock.mockReset();
    resolveTo('93.184.216.34');
    computer = new FakeComputer();
    toolset = new ComputerUseToolset({computer});
  });

  it.each([
    ['open_web_browser', {}, 'openWebBrowser', undefined],
    ['click_at', {x: 500, y: 500}, 'clickAt', {x: 960, y: 540}],
    ['hover_at', {x: 500, y: 500}, 'hoverAt', {x: 960, y: 540}],
    [
      'type_text_at',
      {x: 500, y: 500, text: 'hello'},
      'typeTextAt',
      {
        x: 960,
        y: 540,
        text: 'hello',
        pressEnter: true,
        clearBeforeTyping: true,
      },
    ],
    [
      'scroll_document',
      {direction: 'down'},
      'scrollDocument',
      {direction: 'down'},
    ],
    [
      'scroll_at',
      {x: 500, y: 500, direction: 'up', magnitude: 3},
      'scrollAt',
      {x: 960, y: 540, direction: 'up', magnitude: 3},
    ],
    ['wait', {seconds: 2}, 'wait', {seconds: 2}],
    ['go_back', {}, 'goBack', undefined],
    ['go_forward', {}, 'goForward', undefined],
    ['search', {}, 'search', undefined],
    [
      'navigate',
      {url: 'https://example.com/search?q=adk'},
      'navigate',
      {url: 'https://example.com/search?q=adk'},
    ],
    [
      'key_combination',
      {keys: ['control', 'c']},
      'keyCombination',
      {keys: ['control', 'c']},
    ],
    [
      'drag_and_drop',
      {x: 500, y: 500, destination_x: 250, destination_y: 250},
      'dragAndDrop',
      {x: 960, y: 540, destinationX: 480, destinationY: 270},
    ],
    ['current_state', {}, 'currentState', undefined],
  ])('routes %s to the driver', async (name, args, method, expected) => {
    await runAction(toolset, name, args);

    expect(computer.methodNames()).toEqual([method]);
    expect(computer.argsFor(method)).toEqual(expected);
  });

  it('honours the typing flags the model set', async () => {
    await runAction(toolset, 'type_text_at', {
      x: 0,
      y: 0,
      text: 'hello',
      press_enter: false,
      clear_before_typing: false,
    });

    expect(computer.argsFor('typeTextAt')).toEqual({
      x: 0,
      y: 0,
      text: 'hello',
      pressEnter: false,
      clearBeforeTyping: false,
    });
  });

  it('prepares the driver before each action', async () => {
    const toolContext = createToolContext();

    await runAction(toolset, 'click_at', {x: 1, y: 1}, toolContext);
    await runAction(toolset, 'go_back', {}, toolContext);

    expect(computer.preparedWith).toEqual([toolContext, toolContext]);
  });

  it('rejects an argument the action schema does not allow', async () => {
    await expect(
      runAction(toolset, 'scroll_document', {direction: 'diagonal'}),
    ).rejects.toThrow();
    expect(computer.methodNames()).toEqual([]);
  });

  it('keeps the out-of-band safety decision away from the driver', async () => {
    await runAction(toolset, 'click_at', {
      x: 0,
      y: 0,
      safety_decision: {decision: 'proceed'},
    });

    expect(computer.argsFor('clickAt')).toEqual({x: 0, y: 0});
  });
});

describe('ComputerUseToolset processLlmRequest', () => {
  beforeEach(() => {
    lookupMock.mockReset();
    resolveTo('93.184.216.34');
  });

  it('registers every action and asks the API for the declarations', async () => {
    const llmRequest = createTestLlmRequest();
    const toolset = new ComputerUseToolset({computer: new FakeComputer()});

    await toolset.processLlmRequest(createToolContext(), llmRequest);

    expect(Object.keys(llmRequest.toolsDict)).toEqual(ACTION_NAMES);
    expect(llmRequest.config?.tools).toEqual([
      {
        computerUse: {
          environment: Environment.ENVIRONMENT_BROWSER,
          excludedPredefinedFunctions: undefined,
        },
      },
    ]);
  });

  it('passes the excluded functions to the API', async () => {
    const llmRequest = createTestLlmRequest();
    const toolset = new ComputerUseToolset({
      computer: new FakeComputer(),
      excludedPredefinedFunctions: ['drag_and_drop'],
    });

    await toolset.processLlmRequest(createToolContext(), llmRequest);

    expect(llmRequest.config?.tools?.[0]).toEqual({
      computerUse: {
        environment: Environment.ENVIRONMENT_BROWSER,
        excludedPredefinedFunctions: ['drag_and_drop'],
      },
    });
  });

  it('maps an unspecified environment through unchanged', async () => {
    const computer = new FakeComputer();
    vi.spyOn(computer, 'environment').mockResolvedValue(
      ComputerEnvironment.ENVIRONMENT_UNSPECIFIED,
    );
    const llmRequest = createTestLlmRequest();

    await new ComputerUseToolset({computer}).processLlmRequest(
      createToolContext(),
      llmRequest,
    );

    expect(llmRequest.config?.tools?.[0]).toEqual({
      computerUse: {
        environment: Environment.ENVIRONMENT_UNSPECIFIED,
        excludedPredefinedFunctions: undefined,
      },
    });
  });

  it('adds no second config when computer use is already configured', async () => {
    const llmRequest: LlmRequest = createTestLlmRequest({
      config: {
        tools: [{computerUse: {environment: Environment.ENVIRONMENT_BROWSER}}],
      },
    });
    const toolset = new ComputerUseToolset({computer: new FakeComputer()});

    await toolset.processLlmRequest(createToolContext(), llmRequest);

    expect(llmRequest.config?.tools).toHaveLength(1);
    // The actions are registered regardless, or none of them would dispatch.
    expect(Object.keys(llmRequest.toolsDict)).toEqual(ACTION_NAMES);
  });

  it('keeps a tool config that is not a computer-use one', async () => {
    const llmRequest = createTestLlmRequest({
      config: {tools: [{urlContext: {}}]},
    });
    const toolset = new ComputerUseToolset({computer: new FakeComputer()});

    await toolset.processLlmRequest(createToolContext(), llmRequest);

    expect(llmRequest.config?.tools).toHaveLength(2);
  });

  it('registers only the actions a request processor allowed', async () => {
    const llmRequest = createTestLlmRequest({allowedTools: ['click_at']});
    const toolset = new ComputerUseToolset({computer: new FakeComputer()});

    await toolset.processLlmRequest(createToolContext(), llmRequest);

    expect(Object.keys(llmRequest.toolsDict)).toEqual(['click_at']);
  });

  it('surfaces an error the driver raised while reporting its environment', async () => {
    const computer = new FakeComputer();
    vi.spyOn(computer, 'environment').mockRejectedValue(
      new Error('driver is gone'),
    );

    await expect(
      new ComputerUseToolset({computer}).processLlmRequest(
        createToolContext(),
        createTestLlmRequest(),
      ),
    ).rejects.toThrow('driver is gone');
  });
});

describe('ComputerUseToolset navigate url guard', () => {
  let computer: FakeComputer;

  beforeEach(() => {
    lookupMock.mockReset();
    resolveTo('93.184.216.34');
    computer = new FakeComputer();
    computer.url = 'https://example.com/current';
  });

  it.each([
    [
      'the cloud metadata endpoint',
      'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token',
    ],
    ['a backslash in the authority', 'http://169.254.169.254\\@example.com/'],
    ['a non-http scheme', 'file:///etc/passwd'],
    ['a localhost target', 'http://localhost:3000/'],
    ['an unparseable url', 'not a url'],
  ])('refuses %s without resolving or navigating', async (_name, url) => {
    const toolset = new ComputerUseToolset({computer});

    const response = await runAction(toolset, 'navigate', {url});

    expect(response).toEqual({
      error: URL_REFUSED_ERROR,
      url: 'https://example.com/current',
    });
    expect(computer.methodNames()).not.toContain('navigate');
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('refuses a url that is not a string', async () => {
    const toolset = new ComputerUseToolset({computer});

    expect(await runAction(toolset, 'navigate', {url: 42})).toEqual({
      error: URL_REFUSED_ERROR,
      url: 'https://example.com/current',
    });
    expect(computer.methodNames()).not.toContain('navigate');
  });

  it('passes a public url to the driver byte for byte', async () => {
    const toolset = new ComputerUseToolset({computer});

    await runAction(toolset, 'navigate', {
      url: 'https://example.com/search?q=adk',
    });

    expect(computer.argsFor('navigate')).toEqual({
      url: 'https://example.com/search?q=adk',
    });
    expect(lookupMock).toHaveBeenCalledOnce();
  });

  it('refuses a host that resolves to a private address', async () => {
    resolveTo('10.0.0.5');
    const toolset = new ComputerUseToolset({computer});

    expect(
      await runAction(toolset, 'navigate', {url: 'https://internal.test/'}),
    ).toEqual({
      error: URL_REFUSED_ERROR,
      url: 'https://example.com/current',
    });
    expect(lookupMock).toHaveBeenCalledOnce();
    expect(computer.methodNames()).not.toContain('navigate');
  });

  it('allows a private target when the caller opted in, without resolving', async () => {
    const toolset = new ComputerUseToolset({
      computer,
      allowPrivateNetworkAccess: true,
    });

    await runAction(toolset, 'navigate', {url: 'http://127.0.0.1:8000/'});

    expect(computer.argsFor('navigate')).toEqual({
      url: 'http://127.0.0.1:8000/',
    });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('still refuses a non-http scheme when the caller opted in', async () => {
    const toolset = new ComputerUseToolset({
      computer,
      allowPrivateNetworkAccess: true,
    });

    expect(
      await runAction(toolset, 'navigate', {url: 'file:///etc/passwd'}),
    ).toEqual({
      error: URL_REFUSED_ERROR,
      url: 'https://example.com/current',
    });
  });

  it('still prepares the driver for a refused navigate', async () => {
    const toolset = new ComputerUseToolset({computer});
    const toolContext = createToolContext();

    await runAction(
      toolset,
      'navigate',
      {url: 'http://localhost:3000/'},
      toolContext,
    );

    expect(computer.preparedWith).toEqual([toolContext]);
  });
});

describe('ComputerUseToolset.adaptComputerUseTool', () => {
  let llmRequest: LlmRequest;
  let toolset: ComputerUseToolset;

  /** Builds a replacement for `tool` under a new wire name. */
  function rename(tool: ComputerUseTool, name: string): ComputerUseTool {
    return new ComputerUseTool({
      name,
      description: 'Waits briefly.',
      screenSize: tool.screenSize,
      virtualScreenSize: tool.virtualScreenSize,
      invoke: async () => ({status: 'waited'}),
    });
  }

  beforeEach(async () => {
    lookupMock.mockReset();
    resolveTo('93.184.216.34');
    llmRequest = createTestLlmRequest();
    toolset = new ComputerUseToolset({computer: new FakeComputer()});
  });

  it('replaces the action under the replacement name', async () => {
    await toolset.processLlmRequest(createToolContext(), llmRequest);

    await ComputerUseToolset.adaptComputerUseTool({
      name: 'wait',
      llmRequest,
      adapt: (tool) => rename(tool, 'wait_briefly'),
    });

    expect(llmRequest.toolsDict['wait']).toBeUndefined();
    expect(llmRequest.toolsDict['wait_briefly'].name).toBe('wait_briefly');
  });

  it('accepts an adapter that resolves asynchronously', async () => {
    await toolset.processLlmRequest(createToolContext(), llmRequest);

    await ComputerUseToolset.adaptComputerUseTool({
      name: 'wait',
      llmRequest,
      adapt: async (tool) => rename(tool, 'wait_briefly'),
    });

    expect(llmRequest.toolsDict['wait_briefly']).toBeDefined();
  });

  it('keeps the action when the replacement carries the same name', async () => {
    await toolset.processLlmRequest(createToolContext(), llmRequest);

    await ComputerUseToolset.adaptComputerUseTool({
      name: 'wait',
      llmRequest,
      adapt: (tool) => rename(tool, 'wait'),
    });

    expect(llmRequest.toolsDict['wait'].description).toBe('Waits briefly.');
  });

  it.each([
    ['an unknown action', 'fly'],
    ['a lifecycle method', 'screen_size'],
  ])('leaves the request untouched for %s', async (_name, name) => {
    await toolset.processLlmRequest(createToolContext(), llmRequest);
    const before = {...llmRequest.toolsDict};

    await ComputerUseToolset.adaptComputerUseTool({
      name,
      llmRequest,
      adapt: (tool) => rename(tool, 'replacement'),
    });

    expect(llmRequest.toolsDict).toEqual(before);
  });

  it('leaves the request untouched for an action that was never registered', async () => {
    await ComputerUseToolset.adaptComputerUseTool({
      name: 'wait',
      llmRequest,
      adapt: (tool) => rename(tool, 'wait_briefly'),
    });

    expect(llmRequest.toolsDict).toEqual({});
  });
});
