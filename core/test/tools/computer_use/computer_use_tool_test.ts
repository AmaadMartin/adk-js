/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ComputerUseFunction,
  ComputerUseTool,
  FunctionTool,
  GOOGLE_SEARCH,
  LlmRequest,
  ScreenSize,
  ToolConfirmation,
  isComputerUseTool,
} from '@google/adk';
import {ComputerUse, Environment} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {MOCK_SCREENSHOT, createToolContext} from './computer_use_test_utils.js';

/** The base64 of the bytes every mock action returns. */
const MOCK_SCREENSHOT_BASE64 = 'dGVzdA==';

const SCREEN_SIZE: ScreenSize = {width: 1920, height: 1080};

/** Builds a tool that records the arguments its function received. */
function toolRecordingArgs(virtualScreenSize?: ScreenSize): {
  tool: ComputerUseTool;
  received: () => unknown;
} {
  let received: unknown;
  const tool = new ComputerUseTool({
    name: 'click_at',
    description: 'Clicks.',
    screenSize: SCREEN_SIZE,
    virtualScreenSize,
    execute: async (args) => {
      received = args;
      return 'clicked';
    },
  });
  return {tool, received: () => received};
}

/** Builds a tool over `execute`, with the default virtual screen size. */
function toolOver(execute: ComputerUseFunction): ComputerUseTool {
  return new ComputerUseTool({
    name: 'current_state',
    description: 'Reads the page.',
    screenSize: SCREEN_SIZE,
    execute,
  });
}

describe('ComputerUseTool construction', () => {
  it('defaults the virtual screen size to 1000x1000', () => {
    const {tool} = toolRecordingArgs();

    expect(tool.virtualScreenSize).toEqual({width: 1000, height: 1000});
    expect(tool.screenSize).toEqual(SCREEN_SIZE);
  });

  it.each([
    {width: 0, height: 1080},
    {width: 1920, height: 0},
    {width: -1, height: 1080},
    {width: Number.NaN, height: 1080},
  ])('rejects the screen size %o', (screenSize) => {
    expect(
      () =>
        new ComputerUseTool({
          name: 'click_at',
          description: 'Clicks.',
          screenSize,
          execute: async () => undefined,
        }),
    ).toThrow('screenSize dimensions must be positive');
  });

  it.each([
    {width: 0, height: 1000},
    {width: 1000, height: 0},
  ])('rejects the virtual screen size %o', (virtualScreenSize) => {
    expect(
      () =>
        new ComputerUseTool({
          name: 'click_at',
          description: 'Clicks.',
          screenSize: SCREEN_SIZE,
          virtualScreenSize,
          execute: async () => undefined,
        }),
    ).toThrow('virtualScreenSize dimensions must be positive');
  });

  it('is recognised by isComputerUseTool', () => {
    const {tool} = toolRecordingArgs();

    expect(isComputerUseTool(tool)).toBe(true);
    expect(isComputerUseTool({name: 'click_at'})).toBe(false);
  });
});

describe('ComputerUseTool coordinate normalization', () => {
  it('scales x and y onto the real screen', async () => {
    const {tool, received} = toolRecordingArgs();

    await tool.runAsync({
      args: {x: 500, y: 500},
      toolContext: createToolContext(),
    });

    expect(received()).toEqual({x: 960, y: 540});
  });

  it('truncates toward zero rather than rounding', async () => {
    const {tool, received} = toolRecordingArgs();

    await tool.runAsync({args: {x: 1, y: 1}, toolContext: createToolContext()});

    expect(received()).toEqual({x: 1, y: 1});
  });

  it('clamps above the screen to the last pixel', async () => {
    const {tool, received} = toolRecordingArgs();

    await tool.runAsync({
      args: {x: 1000, y: 1000},
      toolContext: createToolContext(),
    });

    expect(received()).toEqual({x: 1919, y: 1079});
  });

  it('clamps below zero to zero', async () => {
    const {tool, received} = toolRecordingArgs();

    await tool.runAsync({
      args: {x: -10, y: -10},
      toolContext: createToolContext(),
    });

    expect(received()).toEqual({x: 0, y: 0});
  });

  it('scales the drag destination too', async () => {
    const {tool, received} = toolRecordingArgs();

    await tool.runAsync({
      args: {x: 0, y: 0, destination_x: 500, destination_y: 500},
      toolContext: createToolContext(),
    });

    expect(received()).toEqual({
      x: 0,
      y: 0,
      destination_x: 960,
      destination_y: 540,
    });
  });

  it('scales from a custom virtual screen size', async () => {
    const {tool, received} = toolRecordingArgs({width: 500, height: 500});

    await tool.runAsync({
      args: {x: 250, y: 250},
      toolContext: createToolContext(),
    });

    expect(received()).toEqual({x: 960, y: 540});
  });

  it('leaves the other arguments alone', async () => {
    const {tool, received} = toolRecordingArgs();

    await tool.runAsync({
      args: {text: 'hello', press_enter: false},
      toolContext: createToolContext(),
    });

    expect(received()).toEqual({text: 'hello', press_enter: false});
  });

  it('rejects a non-numeric x', async () => {
    const {tool} = toolRecordingArgs();

    await expect(
      tool.runAsync({args: {x: 'left'}, toolContext: createToolContext()}),
    ).rejects.toThrow('x coordinate must be numeric, got string');
  });

  it('rejects a non-numeric y', async () => {
    const {tool} = toolRecordingArgs();

    await expect(
      tool.runAsync({args: {y: null}, toolContext: createToolContext()}),
    ).rejects.toThrow('y coordinate must be numeric, got object');
  });

  it('rejects a non-numeric drag destination', async () => {
    const {tool} = toolRecordingArgs();

    await expect(
      tool.runAsync({
        args: {destination_y: 'bottom'},
        toolContext: createToolContext(),
      }),
    ).rejects.toThrow('y coordinate must be numeric, got string');
  });
});

describe('ComputerUseTool response mapping', () => {
  it('renders a computer state as a png image response', async () => {
    const tool = toolOver(async () => ({
      screenshot: MOCK_SCREENSHOT,
      url: 'https://example.com/',
    }));

    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({
      image: {mimetype: 'image/png', data: MOCK_SCREENSHOT_BASE64},
      url: 'https://example.com/',
    });
  });

  it('passes a non-state return value through untouched', async () => {
    const tool = toolOver(async () => ({custom: 'payload'}));

    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({custom: 'payload'});
  });

  it('propagates an error the action threw', async () => {
    const tool = toolOver(async () => {
      throw new Error('driver crashed');
    });

    await expect(
      tool.runAsync({args: {}, toolContext: createToolContext()}),
    ).rejects.toThrow("Error in tool 'current_state': driver crashed");
  });
});

describe('ComputerUseTool.processLlmRequest', () => {
  const COMPUTER_USE: ComputerUse = {
    environment: Environment.ENVIRONMENT_BROWSER,
  };

  function emptyRequest(): LlmRequest {
    return {contents: [], toolsDict: {}, liveConnectConfig: {}};
  }

  function configuredTool(computerUse?: ComputerUse): ComputerUseTool {
    return new ComputerUseTool({
      name: 'current_state',
      description: 'Reads the page.',
      screenSize: SCREEN_SIZE,
      computerUse,
      execute: async () => undefined,
    });
  }

  function register(
    tool: ComputerUseTool,
    llmRequest: LlmRequest,
  ): Promise<void> {
    return tool.processLlmRequest({
      toolContext: createToolContext(),
      llmRequest,
    });
  }

  it('registers itself so a call naming it can resolve', async () => {
    const tool = configuredTool(COMPUTER_USE);
    const llmRequest = emptyRequest();

    await tool.processLlmRequest({
      toolContext: createToolContext(),
      llmRequest,
    });

    expect(llmRequest.toolsDict['current_state']).toBe(tool);
  });

  it('puts the model into computer-use mode', async () => {
    const llmRequest = emptyRequest();

    await register(configuredTool(COMPUTER_USE), llmRequest);

    expect(llmRequest.config?.tools).toEqual([{computerUse: COMPUTER_USE}]);
  });

  it('declares no function, because the model knows the predefined set', async () => {
    const llmRequest = emptyRequest();

    await register(configuredTool(COMPUTER_USE), llmRequest);

    expect(
      (llmRequest.config?.tools ?? []).flatMap((entry) =>
        'functionDeclarations' in entry
          ? (entry.functionDeclarations ?? [])
          : [],
      ),
    ).toEqual([]);
  });

  it('adds no second configuration to a request that already carries one', async () => {
    const llmRequest = emptyRequest();
    llmRequest.config = {tools: [{computerUse: COMPUTER_USE}]};

    await register(configuredTool(COMPUTER_USE), llmRequest);

    expect(llmRequest.config.tools).toHaveLength(1);
    expect(llmRequest.toolsDict['current_state']).toBeDefined();
  });

  // The predefined names are generic, so a user tool can hold one already.
  // Overwriting it would take the user's tool away without saying so.
  it('reports a callable tool already holding the name', async () => {
    const llmRequest = emptyRequest();
    const userTool = new FunctionTool({
      name: 'current_state',
      description: "The user's own tool.",
      execute: async () => 'mine',
    });
    llmRequest.toolsDict['current_state'] = userTool;

    await expect(
      register(configuredTool(COMPUTER_USE), llmRequest),
    ).rejects.toThrow('Duplicate tool name: current_state');
    expect(llmRequest.toolsDict['current_state']).toBe(userTool);
  });

  it('registers twice without reporting itself as a duplicate', async () => {
    const llmRequest = emptyRequest();
    const tool = configuredTool(COMPUTER_USE);

    await register(tool, llmRequest);
    await register(tool, llmRequest);

    expect(llmRequest.toolsDict['current_state']).toBe(tool);
    expect(llmRequest.config?.tools).toHaveLength(1);
  });

  // A tool the model runs itself holds the name only so a call can be routed,
  // so a genuinely callable tool of the same name takes it over.
  it('displaces an in-model tool holding the name', async () => {
    const llmRequest = emptyRequest();
    llmRequest.toolsDict['current_state'] = GOOGLE_SEARCH;
    const tool = configuredTool(COMPUTER_USE);

    await register(tool, llmRequest);

    expect(llmRequest.toolsDict['current_state']).toBe(tool);
  });

  it('registers without configuring when it carries no configuration', async () => {
    const llmRequest = emptyRequest();

    await register(configuredTool(), llmRequest);

    expect(llmRequest.toolsDict['current_state']).toBeDefined();
    expect(llmRequest.config).toBeUndefined();
  });
});

describe('ComputerUseTool safety confirmation', () => {
  it('pauses the call when the model asks for confirmation', async () => {
    let ran = false;
    const tool = toolOver(async () => {
      ran = true;
      return 'done';
    });
    const toolContext = createToolContext({functionCallId: 'fc-1'});

    const result = await tool.runAsync({
      args: {
        safety_decision: {
          decision: 'require_confirmation',
          explanation: 'This deletes the account.',
        },
      },
      toolContext,
    });

    expect(result).toEqual({
      error: 'This tool call requires confirmation, please approve or reject.',
    });
    expect(ran).toBe(false);
    expect(toolContext.actions.skipSummarization).toBe(true);
    expect(toolContext.actions.requestedToolConfirmations['fc-1'].hint).toBe(
      'This deletes the account.',
    );
  });

  it('falls back to a generic hint when the model explains nothing', async () => {
    const tool = toolOver(async () => 'done');
    const toolContext = createToolContext({functionCallId: 'fc-1'});

    await tool.runAsync({
      args: {safety_decision: {decision: 'require_confirmation'}},
      toolContext,
    });

    expect(toolContext.actions.requestedToolConfirmations['fc-1'].hint).toBe(
      'This computer use action requires safety confirmation.',
    );
  });

  it('runs normally when the safety decision is not a confirmation', async () => {
    const tool = toolOver(async () => 'done');

    const result = await tool.runAsync({
      args: {safety_decision: {decision: 'allow'}},
      toolContext: createToolContext({functionCallId: 'fc-1'}),
    });

    expect(result).toBe('done');
  });

  it('runs normally when the safety decision is malformed', async () => {
    const tool = toolOver(async () => 'done');

    const result = await tool.runAsync({
      args: {safety_decision: {decision: 42, explanation: 7}},
      toolContext: createToolContext({functionCallId: 'fc-1'}),
    });

    expect(result).toBe('done');
  });

  it('runs normally when safety_decision is not an object', async () => {
    const tool = toolOver(async () => 'done');

    const result = await tool.runAsync({
      args: {safety_decision: 'require_confirmation'},
      toolContext: createToolContext({functionCallId: 'fc-1'}),
    });

    expect(result).toBe('done');
  });

  it('refuses a call the user rejected', async () => {
    let ran = false;
    const tool = toolOver(async () => {
      ran = true;
      return 'done';
    });

    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext({
        toolConfirmation: new ToolConfirmation({confirmed: false}),
      }),
    });

    expect(result).toEqual({error: 'This tool call is rejected.'});
    expect(ran).toBe(false);
  });

  it('acknowledges the approval on an object response', async () => {
    const tool = toolOver(async () => ({
      screenshot: MOCK_SCREENSHOT,
      url: 'https://example.com/',
    }));

    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext({
        toolConfirmation: new ToolConfirmation({confirmed: true}),
      }),
    });

    expect(result).toEqual({
      image: {mimetype: 'image/png', data: MOCK_SCREENSHOT_BASE64},
      url: 'https://example.com/',
      safety_acknowledgement: 'true',
    });
  });

  it('wraps a non-object response before acknowledging the approval', async () => {
    const tool = toolOver(async () => 'plain text');

    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext({
        toolConfirmation: new ToolConfirmation({confirmed: true}),
      }),
    });

    expect(result).toEqual({
      result: 'plain text',
      safety_acknowledgement: 'true',
    });
  });
});
