/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ComputerUseTool,
  ComputerUseToolOptions,
  Context,
  FunctionTool,
  isComputerUseTool,
  ToolConfirmation,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {
  createTestLlmRequest,
  createToolContext,
} from './computer_use_test_utils.js';

/** A 1920x1080 screen, the size the parity anchor values are stated against. */
const SCREEN: readonly [number, number] = [1920, 1080];

/**
 * Builds a tool that records the arguments its action received.
 *
 * @param options Overrides of the tool configuration.
 * @return The tool and the recorded calls.
 */
function createTool(options: Partial<ComputerUseToolOptions> = {}): {
  tool: ComputerUseTool;
  calls: Array<Record<string, unknown>>;
  result: {value: unknown};
} {
  const calls: Array<Record<string, unknown>> = [];
  const result: {value: unknown} = {value: {status: 'success'}};
  const tool = new ComputerUseTool({
    name: 'click_at',
    description: 'Clicks at a coordinate.',
    screenSize: SCREEN,
    invoke: async (args) => {
      calls.push(args);
      return result.value;
    },
    ...options,
  });
  return {tool, calls, result};
}

describe('ComputerUseTool constructor', () => {
  it.each([
    ['a zero width', [0, 1080]],
    ['a zero height', [1920, 0]],
    ['a negative width', [-1, 1080]],
    ['a NaN height', [1920, Number.NaN]],
    ['an infinite width', [Number.POSITIVE_INFINITY, 1080]],
  ])('rejects %s in screenSize', (_name, size) => {
    expect(() => createTool({screenSize: size as [number, number]})).toThrow(
      'screenSize dimensions must be positive',
    );
  });

  it.each([
    ['a zero width', [0, 1000]],
    ['a negative height', [1000, -5]],
    ['a NaN width', [Number.NaN, 1000]],
    ['an infinite height', [1000, Number.POSITIVE_INFINITY]],
  ])('rejects %s in virtualScreenSize', (_name, size) => {
    expect(() =>
      createTool({virtualScreenSize: size as [number, number]}),
    ).toThrow('virtualScreenSize dimensions must be positive');
  });

  it('defaults the virtual screen to 1000x1000', () => {
    expect(createTool().tool.virtualScreenSize).toEqual([1000, 1000]);
  });

  it('declares no function, so the API can declare it instead', async () => {
    const {tool} = createTool();
    const llmRequest = createTestLlmRequest();

    expect(tool._getDeclaration()).toBeUndefined();
    await tool.processLlmRequest({
      toolContext: createToolContext(),
      llmRequest,
    });

    expect(llmRequest.config?.tools ?? []).toEqual([]);
    expect(llmRequest.toolsDict).toEqual({});
  });
});

describe('isComputerUseTool', () => {
  it('is true for a computer-use tool', () => {
    expect(isComputerUseTool(createTool().tool)).toBe(true);
  });

  it('is false for a plain function tool and for a non-object', () => {
    const functionTool = new FunctionTool({
      name: 'click_at',
      description: 'Clicks.',
      execute: async () => 'ok',
    });

    expect(isComputerUseTool(functionTool)).toBe(false);
    expect(isComputerUseTool(null)).toBe(false);
    expect(isComputerUseTool('click_at')).toBe(false);
  });
});

describe('ComputerUseTool coordinate normalization', () => {
  /** Runs the tool and returns the arguments the action received. */
  async function normalize(
    args: Record<string, unknown>,
    options: Partial<ComputerUseToolOptions> = {},
  ): Promise<Record<string, unknown>> {
    const {tool, calls} = createTool(options);
    await tool.runAsync({args, toolContext: createToolContext()});
    return calls[0];
  }

  it.each([
    [0, 0],
    [500, 960],
    [1000, 1919],
    [-100, 0],
    [1500, 1919],
  ])('maps x=%i onto %i on a 1920px wide screen', async (x, expected) => {
    expect(await normalize({x, y: 0})).toEqual({x: expected, y: 0});
  });

  it.each([
    [0, 0],
    [500, 540],
    [1000, 1079],
    [-100, 0],
  ])('maps y=%i onto %i on a 1080px tall screen', async (y, expected) => {
    expect(await normalize({x: 0, y})).toEqual({x: 0, y: expected});
  });

  it('scales against a custom virtual screen', async () => {
    const options = {virtualScreenSize: [2000, 2000] as [number, number]};

    expect(await normalize({x: 1000, y: 1000}, options)).toEqual({
      x: 960,
      y: 540,
    });
    expect(await normalize({x: 2000, y: 2000}, options)).toEqual({
      x: 1919,
      y: 1079,
    });
  });

  it('scales destination_x against the width and destination_y against the height', async () => {
    // A non-square screen, so swapping the two axes would change the result.
    expect(
      await normalize(
        {x: 0, y: 0, destination_x: 500, destination_y: 500},
        {screenSize: [1920, 1080]},
      ),
    ).toEqual({x: 0, y: 0, destination_x: 960, destination_y: 540});
  });

  it('leaves a coordinate that is not a number untouched', async () => {
    expect(await normalize({x: 'left', y: null, text: 'hi'})).toEqual({
      x: 'left',
      y: null,
      text: 'hi',
    });
  });

  it('leaves the other arguments untouched', async () => {
    expect(
      await normalize({x: 500, text: 'hello', press_enter: false}),
    ).toEqual({x: 960, text: 'hello', press_enter: false});
  });
});

describe('ComputerUseTool response shaping', () => {
  it('turns a computer state into the image payload', async () => {
    const {tool, result} = createTool();
    result.value = {
      screenshot: new Uint8Array([1, 2, 3]),
      url: 'https://example.com/',
    };

    const response = await tool.runAsync({
      args: {x: 0, y: 0},
      toolContext: createToolContext(),
    });

    expect(response).toEqual({
      image: {mimetype: 'image/png', data: 'AQID'},
      url: 'https://example.com/',
    });
  });

  it('encodes an absent screenshot as empty data', async () => {
    const {tool, result} = createTool();
    result.value = {url: 'https://example.com/'};

    expect(
      await tool.runAsync({args: {}, toolContext: createToolContext()}),
    ).toEqual({
      image: {mimetype: 'image/png', data: ''},
      url: 'https://example.com/',
    });
  });

  it('passes a result that is not a computer state through untouched', async () => {
    const {tool, result} = createTool();
    result.value = {status: 'success'};

    expect(
      await tool.runAsync({args: {}, toolContext: createToolContext()}),
    ).toEqual({status: 'success'});
  });
});

describe('ComputerUseTool safety confirmation', () => {
  const REQUIRE = {safety_decision: {decision: 'require_confirmation'}};

  it('asks for confirmation with the default hint and does not act', async () => {
    const {tool, calls} = createTool();
    const toolContext = createToolContext({functionCallId: 'call-1'});

    const response = await tool.runAsync({args: {...REQUIRE}, toolContext});

    expect(response).toEqual({
      error: 'This tool call requires confirmation, please approve or reject.',
    });
    expect(calls).toEqual([]);
    expect(toolContext.actions.skipSummarization).toBe(true);
    expect(toolContext.actions.requestedToolConfirmations['call-1'].hint).toBe(
      'This computer use action requires safety confirmation.',
    );
  });

  it('asks for confirmation with the explanation the model supplied', async () => {
    const {tool} = createTool();
    const toolContext = createToolContext({functionCallId: 'call-2'});

    await tool.runAsync({
      args: {
        safety_decision: {
          decision: 'require_confirmation',
          explanation: 'This click submits a payment.',
        },
      },
      toolContext,
    });

    expect(toolContext.actions.requestedToolConfirmations['call-2'].hint).toBe(
      'This click submits a payment.',
    );
  });

  it('falls back to the default hint when the explanation is empty', async () => {
    const {tool} = createTool();
    const toolContext = createToolContext({functionCallId: 'call-3'});

    await tool.runAsync({
      args: {
        safety_decision: {decision: 'require_confirmation', explanation: ''},
      },
      toolContext,
    });

    expect(toolContext.actions.requestedToolConfirmations['call-3'].hint).toBe(
      'This computer use action requires safety confirmation.',
    );
  });

  it.each([
    ['another decision', {safety_decision: {decision: 'proceed'}}],
    ['a decision that is not an object', {safety_decision: 'proceed'}],
    [
      'a decision that is an array',
      {safety_decision: ['require_confirmation']},
    ],
    ['a null decision', {safety_decision: null}],
    ['no safety decision at all', {}],
  ])('runs the action for %s', async (_name, args) => {
    const {tool, calls} = createTool();

    await tool.runAsync({args, toolContext: createToolContext()});

    expect(calls).toHaveLength(1);
  });

  it('rejects the call when the user declined', async () => {
    const {tool, calls} = createTool();
    const toolContext = createToolContext({
      toolConfirmation: new ToolConfirmation({confirmed: false}),
    });

    expect(await tool.runAsync({args: {x: 1}, toolContext})).toEqual({
      error: 'This tool call is rejected.',
    });
    expect(calls).toEqual([]);
  });

  it('acknowledges a confirmed call', async () => {
    const {tool, result, calls} = createTool();
    result.value = {status: 'success'};
    const toolContext = createToolContext({
      toolConfirmation: new ToolConfirmation({confirmed: true}),
    });

    expect(
      await tool.runAsync({args: {...REQUIRE, x: 500}, toolContext}),
    ).toEqual({status: 'success', safety_acknowledgement: 'true'});
    expect(calls).toHaveLength(1);
  });

  it('wraps a confirmed result that is not an object', async () => {
    const {tool, result} = createTool();
    result.value = 'done';
    const toolContext = createToolContext({
      toolConfirmation: new ToolConfirmation({confirmed: true}),
    });

    expect(await tool.runAsync({args: {}, toolContext})).toEqual({
      result: 'done',
      safety_acknowledgement: 'true',
    });
  });
});

describe('ComputerUseTool error handling', () => {
  it('logs and rethrows an error the driver raised', async () => {
    const {tool} = createTool({
      invoke: async () => {
        throw new Error('browser crashed');
      },
    });

    await expect(
      tool.runAsync({args: {x: 0, y: 0}, toolContext: createToolContext()}),
    ).rejects.toThrow('browser crashed');
  });

  it('does not swallow the error into an error payload', async () => {
    const failure = new Error('navigation timed out');
    const {tool} = createTool({
      invoke: async () => {
        throw failure;
      },
    });

    await expect(
      tool.runAsync({args: {}, toolContext: createToolContext()}),
    ).rejects.toBe(failure);
  });
});

describe('ComputerUseTool context', () => {
  it('hands the tool context to the action', async () => {
    const seen: Context[] = [];
    const {tool} = createTool({
      invoke: async (_args, toolContext) => {
        seen.push(toolContext);
        return {};
      },
    });
    const toolContext = createToolContext();

    await tool.runAsync({args: {}, toolContext});

    expect(seen).toEqual([toolContext]);
  });

  it('does not mutate the arguments the caller passed in', async () => {
    const {tool} = createTool();
    const args = {x: 500, y: 500};

    await tool.runAsync({args, toolContext: createToolContext()});

    expect(args).toEqual({x: 500, y: 500});
  });
});
