/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ComputerUseTool,
  Context,
  createSession,
  InMemorySessionService,
  InvocationContext,
  isComputerUseTool,
  LlmAgent,
  PluginManager,
  ToolConfirmation,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

const SCREENSHOT = new TextEncoder().encode('test_screenshot');
const SCREENSHOT_BASE64 = 'dGVzdF9zY3JlZW5zaG90';

/** Builds a `Context` a tool can run against. */
function createToolContext(options?: {
  functionCallId?: string;
  toolConfirmation?: ToolConfirmation;
}): Context {
  const agent = new LlmAgent({name: 'computer_agent'});
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      agent,
      session: createSession({
        id: 's1',
        appName: 'app',
        userId: 'u1',
      }),
      pluginManager: new PluginManager([]),
      sessionService: new InMemorySessionService(),
    }),
    functionCallId: options?.functionCallId ?? 'call-1',
    toolConfirmation: options?.toolConfirmation,
  });
}

/** Records the arguments an action received, and returns a fixed result. */
function recordingTool(options?: {
  screenSize?: readonly [number, number];
  virtualScreenSize?: readonly [number, number];
  result?: unknown;
  throws?: Error;
}) {
  const received: Array<Record<string, unknown>> = [];
  const tool = new ComputerUseTool({
    name: 'click_at',
    description: 'Clicks at a coordinate.',
    parameters: z.object({x: z.number(), y: z.number()}),
    screenSize: options?.screenSize ?? [1920, 1080],
    virtualScreenSize: options?.virtualScreenSize,
    invoke: async (args) => {
      received.push(args);
      if (options?.throws) {
        throw options.throws;
      }
      return options?.result === undefined
        ? {screenshot: SCREENSHOT, url: 'https://example.com'}
        : options.result;
    },
  });
  return {tool, received};
}

describe('ComputerUseTool construction', () => {
  it('rejects a non-positive screenSize dimension', () => {
    expect(() => recordingTool({screenSize: [0, 1080]})).toThrow(
      'screenSize dimensions must be positive',
    );
    expect(() => recordingTool({screenSize: [1920, -5]})).toThrow(
      'screenSize dimensions must be positive',
    );
  });

  it('rejects a non-finite screenSize dimension', () => {
    expect(() => recordingTool({screenSize: [Number.NaN, 1080]})).toThrow(
      'screenSize dimensions must be positive',
    );
  });

  it('rejects a non-positive virtualScreenSize dimension', () => {
    expect(() => recordingTool({virtualScreenSize: [1000, 0]})).toThrow(
      'virtualScreenSize dimensions must be positive',
    );
  });

  it('defaults the virtual screen to 1000x1000', () => {
    expect(recordingTool().tool.virtualScreenSize).toEqual([1000, 1000]);
  });

  it('is recognised by isComputerUseTool', () => {
    expect(isComputerUseTool(recordingTool().tool)).toBe(true);
    expect(isComputerUseTool({name: 'click_at'})).toBe(false);
    expect(isComputerUseTool(null)).toBe(false);
  });

  it('declares its parameters for introspection', () => {
    const declaration = recordingTool().tool._getDeclaration();

    expect(declaration.name).toBe('click_at');
    expect(declaration.parameters?.properties).toHaveProperty('x');
    expect(declaration.parameters?.properties).toHaveProperty('y');
  });

  it('leaves the request untouched in processLlmRequest', async () => {
    const {tool} = recordingTool();

    await expect(tool.processLlmRequest()).resolves.toBeUndefined();
  });
});

describe('ComputerUseTool coordinate normalization', () => {
  it.each([
    [0, 0],
    [500, 960],
    [1000, 1919],
    [-100, 0],
    [1500, 1919],
  ])('scales x %i to %i on a 1920x1080 screen', async (input, expected) => {
    const {tool, received} = recordingTool();

    await tool.runAsync({
      args: {x: input, y: 0},
      toolContext: createToolContext(),
    });

    expect(received[0].x).toBe(expected);
  });

  it.each([
    [0, 0],
    [500, 540],
    [1000, 1079],
    [-100, 0],
    [1500, 1079],
  ])('scales y %i to %i on a 1920x1080 screen', async (input, expected) => {
    const {tool, received} = recordingTool();

    await tool.runAsync({
      args: {x: 0, y: input},
      toolContext: createToolContext(),
    });

    expect(received[0].y).toBe(expected);
  });

  it('honours a custom virtual screen of 2000x2000', async () => {
    const {tool, received} = recordingTool({virtualScreenSize: [2000, 2000]});

    await tool.runAsync({
      args: {x: 1000, y: 1000},
      toolContext: createToolContext(),
    });
    await tool.runAsync({
      args: {x: 2000, y: 0},
      toolContext: createToolContext(),
    });

    expect(received[0]).toMatchObject({x: 960, y: 540});
    expect(received[1].x).toBe(1919);
  });

  it('honours a 2560x1440 screen with an 800x600 virtual space', async () => {
    const {tool, received} = recordingTool({
      screenSize: [2560, 1440],
      virtualScreenSize: [800, 600],
    });

    await tool.runAsync({
      args: {x: 400, y: 300},
      toolContext: createToolContext(),
    });
    await tool.runAsync({
      args: {x: 800, y: 600},
      toolContext: createToolContext(),
    });

    expect(received[0]).toMatchObject({x: 1280, y: 720});
    expect(received[1]).toMatchObject({x: 2559, y: 1439});
  });

  it('normalizes the drag-and-drop destination coordinates', async () => {
    const received: Array<Record<string, unknown>> = [];
    const tool = new ComputerUseTool({
      name: 'drag_and_drop',
      description: 'Drags an element.',
      parameters: z.object({
        x: z.number(),
        y: z.number(),
        destination_x: z.number(),
        destination_y: z.number(),
      }),
      screenSize: [1920, 1080],
      invoke: async (args) => {
        received.push(args);
        return {};
      },
    });

    await tool.runAsync({
      args: {x: 100, y: 200, destination_x: 800, destination_y: 600},
      toolContext: createToolContext(),
    });

    expect(received[0]).toEqual({
      x: 192,
      y: 216,
      destination_x: 1536,
      destination_y: 648,
    });
  });

  it('passes a non-coordinate action through untouched', async () => {
    const received: Array<Record<string, unknown>> = [];
    const tool = new ComputerUseTool({
      name: 'scroll_document',
      description: 'Scrolls the page.',
      parameters: z.object({direction: z.enum(['up', 'down'])}),
      screenSize: [1920, 1080],
      invoke: async (args) => {
        received.push(args);
        return {};
      },
    });

    await tool.runAsync({
      args: {direction: 'down'},
      toolContext: createToolContext(),
    });

    expect(received[0]).toEqual({direction: 'down'});
  });

  it('leaves a coordinate the model sent as a non-number alone', async () => {
    const {tool, received} = recordingTool();

    await tool.runAsync({
      args: {x: 'not-a-number', y: 500},
      toolContext: createToolContext(),
    });

    expect(received[0].x).toBe('not-a-number');
    expect(received[0].y).toBe(540);
  });
});

describe('ComputerUseTool response shape', () => {
  it('converts a ComputerState into a base64 screenshot payload', async () => {
    const {tool, received} = recordingTool();

    const result = await tool.runAsync({
      args: {x: 500, y: 300},
      toolContext: createToolContext(),
    });

    expect(received[0]).toMatchObject({x: 960, y: 324});
    expect(result).toEqual({
      image: {mimetype: 'image/png', data: SCREENSHOT_BASE64},
      url: 'https://example.com',
    });
  });

  it('omits the image when the state carries no screenshot', async () => {
    const {tool} = recordingTool({result: {url: 'https://example.com'}});

    const result = await tool.runAsync({
      args: {x: 0, y: 0},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({url: 'https://example.com'});
  });

  it('returns a non-ComputerState result unchanged', async () => {
    const {tool} = recordingTool({result: 'plain string'});

    const result = await tool.runAsync({
      args: {x: 0, y: 0},
      toolContext: createToolContext(),
    });

    expect(result).toBe('plain string');
  });

  it('propagates an error the action throws', async () => {
    const {tool} = recordingTool({throws: new Error('driver exploded')});

    await expect(
      tool.runAsync({args: {x: 0, y: 0}, toolContext: createToolContext()}),
    ).rejects.toThrow('driver exploded');
  });
});

describe('ComputerUseTool safety gate', () => {
  it('requests confirmation and skips the action when the model asks', async () => {
    const {tool, received} = recordingTool();
    const toolContext = createToolContext({functionCallId: 'call-42'});

    const result = await tool.runAsync({
      args: {
        x: 500,
        y: 300,
        safety_decision: {decision: 'require_confirmation'},
      },
      toolContext,
    });

    expect(result).toEqual({
      error: 'This tool call requires confirmation, please approve or reject.',
    });
    expect(received).toHaveLength(0);
    expect(toolContext.actions.skipSummarization).toBe(true);
    const requested = toolContext.actions.requestedToolConfirmations['call-42'];
    expect(requested.hint).toBe(
      'This computer use action requires safety confirmation.',
    );
    expect(requested.confirmed).toBe(false);
  });

  it('uses the model explanation as the confirmation hint', async () => {
    const {tool} = recordingTool();
    const toolContext = createToolContext({functionCallId: 'call-7'});

    await tool.runAsync({
      args: {
        x: 0,
        y: 0,
        safety_decision: {
          decision: 'require_confirmation',
          explanation: 'This buys something.',
        },
      },
      toolContext,
    });

    expect(toolContext.actions.requestedToolConfirmations['call-7'].hint).toBe(
      'This buys something.',
    );
  });

  it('runs the action and acknowledges when the human confirmed', async () => {
    const {tool, received} = recordingTool();

    const result = await tool.runAsync({
      args: {x: 500, y: 300},
      toolContext: createToolContext({
        toolConfirmation: new ToolConfirmation({confirmed: true}),
      }),
    });

    expect(received).toHaveLength(1);
    expect(result).toEqual({
      image: {mimetype: 'image/png', data: SCREENSHOT_BASE64},
      url: 'https://example.com',
      safety_acknowledgement: 'true',
    });
  });

  it('wraps a non-object result before acknowledging it', async () => {
    const {tool} = recordingTool({result: 'plain string'});

    const result = await tool.runAsync({
      args: {x: 0, y: 0},
      toolContext: createToolContext({
        toolConfirmation: new ToolConfirmation({confirmed: true}),
      }),
    });

    expect(result).toEqual({
      result: 'plain string',
      safety_acknowledgement: 'true',
    });
  });

  it('rejects the call when the human refused', async () => {
    const {tool, received} = recordingTool();

    const result = await tool.runAsync({
      args: {x: 0, y: 0},
      toolContext: createToolContext({
        toolConfirmation: new ToolConfirmation({confirmed: false}),
      }),
    });

    expect(result).toEqual({error: 'This tool call is rejected.'});
    expect(received).toHaveLength(0);
  });

  it('runs normally for a decision other than require_confirmation', async () => {
    const {tool, received} = recordingTool();

    await tool.runAsync({
      args: {x: 0, y: 0, safety_decision: {decision: 'allow'}},
      toolContext: createToolContext(),
    });

    expect(received).toHaveLength(1);
  });

  it('ignores a safety_decision that is not an object', async () => {
    const {tool, received} = recordingTool();

    await tool.runAsync({
      args: {x: 0, y: 0, safety_decision: 'require_confirmation'},
      toolContext: createToolContext(),
    });

    expect(received).toHaveLength(1);
  });
});
