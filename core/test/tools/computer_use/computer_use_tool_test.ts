/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ComputerUseTool,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  ToolConfirmation,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

function createToolContext(): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'computer_use_test_agent'}),
    session: createSession({id: 'test', appName: 'computer-use-test'}),
    pluginManager: new PluginManager([]),
  });

  return new Context({invocationContext, functionCallId: 'test-call'});
}

describe('ComputerUseTool', () => {
  let context: Context;
  beforeEach(() => {
    context = createToolContext();
  });

  it('validates screen sizes during initialization', () => {
    const fn = async () => {};
    expect(
      () =>
        new ComputerUseTool({
          func: fn,
          screenSize: [0, 1080],
        }),
    ).toThrowError(/screenSize dimensions must be positive/);

    expect(
      () =>
        new ComputerUseTool({
          func: fn,
          screenSize: [1920, 1080],
          virtualScreenSize: [-1, 1000],
        }),
    ).toThrowError(/virtualScreenSize dimensions must be positive/);
  });

  it('normalizes coordinates correctly', async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    const tool = new ComputerUseTool({
      func: async (args) => {
        capturedArgs = args;
      },
      screenSize: [1920, 1080],
    });

    await tool.runAsync({
      args: {x: 500, y: 500, destination_x: 1000, destination_y: 0},
      toolContext: context,
    });

    expect(capturedArgs).toEqual({
      x: 960,
      y: 540,
      destination_x: 1919, // 1000/1000 * 1920 is 1920, clamped to 1919
      destination_y: 0,
    });
  });

  it('normalizes against a custom virtual screen size', async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    const tool = new ComputerUseTool({
      func: async (args) => {
        capturedArgs = args;
      },
      screenSize: [1280, 800],
      virtualScreenSize: [2000, 2000],
    });

    await tool.runAsync({
      args: {destination_x: 1000, destination_y: 1000},
      toolContext: context,
    });

    expect(capturedArgs).toEqual({destination_x: 640, destination_y: 400});
  });

  it('rejects unexpected non-numeric coordinates', async () => {
    const tool = new ComputerUseTool({
      func: async () => {},
      screenSize: [1920, 1080],
    });

    await expect(
      tool.runAsync({
        args: {x: 'not a number'},
        toolContext: context,
      }),
    ).rejects.toThrowError(/coordinate must be numeric/);
  });

  it('handles result format converting to base64 properly', async () => {
    const tool = new ComputerUseTool({
      func: async () => {
        return {
          screenshot: new Uint8Array([72, 101, 108, 108, 111]), // "Hello"
          url: 'https://example.com',
        };
      },
      screenSize: [1920, 1080],
    });

    const response = await tool.runAsync({
      args: {},
      toolContext: context,
    });

    expect(response).toEqual({
      image: {
        mimetype: 'image/png',
        data: Buffer.from('Hello').toString('base64'),
      },
      url: 'https://example.com',
    });
  });

  it('implements safety decisions correctly for require_confirmation', async () => {
    const tool = new ComputerUseTool({
      func: async () => {},
      screenSize: [1920, 1080],
    });

    const response = await tool.runAsync({
      args: {
        safetyDecision: {
          decision: 'require_confirmation',
          explanation: 'Safety first',
        },
      },
      toolContext: context,
    });

    expect(response).toEqual({
      error: 'This tool call requires confirmation, please approve or reject.',
    });
    expect(context.actions.requestedToolConfirmations['test-call'].hint).toBe(
      'Safety first',
    );
  });

  it('ignores a safety decision that is not an object', async () => {
    const tool = new ComputerUseTool({
      func: async () => 'ran',
      screenSize: [1920, 1080],
    });

    const response = await tool.runAsync({
      args: {safety_decision: 'require_confirmation'},
      toolContext: context,
    });

    expect(response).toBe('ran');
  });

  it('rejects call if toolConfirmation is strictly unconfirmed', async () => {
    const tool = new ComputerUseTool({
      func: async () => {},
      screenSize: [1920, 1080],
    });

    context.toolConfirmation = new ToolConfirmation({confirmed: false});

    const response = await tool.runAsync({
      args: {},
      toolContext: context,
    });

    expect(response).toEqual({error: 'This tool call is rejected.'});
  });

  it('returns undefined for _getDeclaration()', () => {
    const tool = new ComputerUseTool({
      func: async () => {},
      screenSize: [1920, 1080],
      name: 'click_at',
    });

    expect(tool._getDeclaration()).toBeUndefined();
  });

  it('adds safety_acknowledgement if confirmation is true', async () => {
    const tool = new ComputerUseTool({
      func: async () => {
        return {something: 'else'};
      },
      screenSize: [1920, 1080],
    });

    context.toolConfirmation = new ToolConfirmation({confirmed: true});

    const response = await tool.runAsync({
      args: {},
      toolContext: context,
    });

    expect(response).toEqual({
      something: 'else',
      safety_acknowledgement: 'true',
    });
  });

  it('provides a no-op processLlmRequest', async () => {
    const tool = new ComputerUseTool({
      func: async () => {},
      screenSize: [1920, 1080],
    });
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    await expect(
      tool.processLlmRequest({llmRequest, toolContext: context}),
    ).resolves.toBeUndefined();
    expect(llmRequest.toolsDict).toEqual({});
  });

  it('reports a screenshot that cannot be base64 encoded', async () => {
    const tool = new ComputerUseTool({
      func: async () => {
        return {screenshot: 123, url: 'https://example.com'};
      },
      screenSize: [1920, 1080],
    });
    const response = await tool.runAsync({args: {}, toolContext: context});
    expect(response).toEqual({
      error: expect.stringContaining('Could not base64 encode screenshot'),
      url: 'https://example.com',
    });
  });

  it('handles non-object response with confirmation', async () => {
    const tool = new ComputerUseTool({
      func: async () => 'raw string',
      screenSize: [1920, 1080],
    });
    context.toolConfirmation = new ToolConfirmation({confirmed: true});
    const response = await tool.runAsync({args: {}, toolContext: context});
    expect(response).toEqual({
      result: 'raw string',
      safety_acknowledgement: 'true',
    });
  });

  it('rejects with error if func throws', async () => {
    const tool = new ComputerUseTool({
      func: async () => {
        throw new Error('func err');
      },
      screenSize: [1920, 1080],
    });
    await expect(
      tool.runAsync({args: {}, toolContext: context}),
    ).rejects.toThrowError('func err');
  });

  it('uses default hint if explanation is missing', async () => {
    const tool = new ComputerUseTool({
      func: async () => {},
      screenSize: [1920, 1080],
    });
    await tool.runAsync({
      args: {safetyDecision: {decision: 'require_confirmation'}},
      toolContext: context,
    });

    expect(context.actions.requestedToolConfirmations['test-call'].hint).toBe(
      'This computer use action requires safety confirmation.',
    );
  });

  it('validates empty name properly', () => {
    expect(
      () =>
        new ComputerUseTool({
          func: async () => {},
          name: '',
          screenSize: [1920, 1080],
        }),
    ).toThrowError('Tool name cannot be empty');
  });

  it('rejects unexpected non-numeric y coordinates', async () => {
    const tool = new ComputerUseTool({
      func: async () => {},
      screenSize: [1920, 1080],
    });

    await expect(
      tool.runAsync({
        args: {y: 'not a number'},
        toolContext: context,
      }),
    ).rejects.toThrowError(/y coordinate must be numeric/);
  });
});
