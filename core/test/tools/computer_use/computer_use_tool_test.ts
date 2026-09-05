/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ComputerState,
  ComputerUseTool,
  Context,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  ToolConfirmation,
  createSession,
  isFunctionTool,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  evaluateSafetyGate,
  normalizeCoordinate,
  normalizeCoordinates,
  toExecuteArguments,
  validateScreenSize,
} from '../../../src/tools/computer_use/computer_use_tool.js';
import {logger} from '../../../src/utils/logger.js';

/** `test_screenshot`, base64-encoded, computed independently of the source. */
const SCREENSHOT_BASE64 = 'dGVzdF9zY3JlZW5zaG90';

const SCREENSHOT = new TextEncoder().encode('test_screenshot');

const DEFAULT_HINT = 'This computer use action requires safety confirmation.';

function makeContext(
  options: {functionCallId?: string; toolConfirmation?: ToolConfirmation} = {},
): Context {
  const session = createSession({id: 's1', appName: 'app', userId: 'u1'});
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'a', model: 'gemini-2.5-flash'}),
    session,
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext, ...options});
}

function makeState(url?: string): ComputerState {
  return {screenshot: SCREENSHOT, url};
}

/** A driver that records the arguments it ran with and returns `result`. */
function makeDriver(result: unknown) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    execute(args: Record<string, unknown>): unknown {
      calls.push(args);
      return result;
    },
  };
}

function makeTool(
  driver: {execute(args: Record<string, unknown>): unknown},
  screenSize: readonly [number, number] = [1920, 1080],
): ComputerUseTool {
  return new ComputerUseTool({
    name: 'click_at',
    description: 'Clicks at a coordinate.',
    screenSize,
    execute: (args) => driver.execute(args),
  });
}

const EXPECTED_IMAGE_PAYLOAD = {
  image: {mimetype: 'image/png', data: SCREENSHOT_BASE64},
  url: 'https://example.com',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ComputerUseTool construction', () => {
  it('exposes the screen size and the default virtual screen size', () => {
    const tool = makeTool(makeDriver(makeState()));

    expect(tool.screenSize).toEqual([1920, 1080]);
    expect(tool.virtualScreenSize).toEqual([1000, 1000]);
    expect(tool.name).toBe('click_at');
  });

  it('falls back to the name of the execute function', () => {
    function openWebBrowser(): string {
      return 'ok';
    }
    const tool = new ComputerUseTool({
      description: 'Opens the browser.',
      screenSize: [1920, 1080],
      execute: openWebBrowser,
    });

    expect(tool.name).toBe('openWebBrowser');
  });

  it('keeps a custom virtual screen size', () => {
    const tool = new ComputerUseTool({
      name: 'click_at',
      description: 'Clicks at a coordinate.',
      screenSize: [1920, 1080],
      virtualScreenSize: [2000, 2000],
      execute: () => 'ok',
    });

    expect(tool.virtualScreenSize).toEqual([2000, 2000]);
  });

  it('rejects a screen size with a non-positive dimension', () => {
    expect(
      () =>
        new ComputerUseTool({
          name: 'click_at',
          description: 'Clicks at a coordinate.',
          screenSize: [0, 1080],
          execute: () => 'ok',
        }),
    ).toThrow('screenSize dimensions must be positive');

    expect(
      () =>
        new ComputerUseTool({
          name: 'click_at',
          description: 'Clicks at a coordinate.',
          screenSize: [1920, -1],
          execute: () => 'ok',
        }),
    ).toThrow('screenSize dimensions must be positive');
  });

  it('rejects a virtual screen size with a non-positive dimension', () => {
    expect(
      () =>
        new ComputerUseTool({
          name: 'click_at',
          description: 'Clicks at a coordinate.',
          screenSize: [1920, 1080],
          virtualScreenSize: [0, 1000],
          execute: () => 'ok',
        }),
    ).toThrow('virtualScreenSize dimensions must be positive');

    expect(
      () =>
        new ComputerUseTool({
          name: 'click_at',
          description: 'Clicks at a coordinate.',
          screenSize: [1920, 1080],
          virtualScreenSize: [1000, -1],
          execute: () => 'ok',
        }),
    ).toThrow('virtualScreenSize dimensions must be positive');
  });
});

describe('validateScreenSize', () => {
  it('accepts a pair of positive dimensions', () => {
    expect(() => validateScreenSize('screenSize', [1920, 1080])).not.toThrow();
  });

  it('rejects a dimension that is not finite', () => {
    expect(() =>
      validateScreenSize('virtualScreenSize', [Number.POSITIVE_INFINITY, 1000]),
    ).toThrow('virtualScreenSize dimensions must be positive');
  });
});

describe('normalizeCoordinate', () => {
  it('scales and clamps an x coordinate on a 1920 wide screen', () => {
    expect(normalizeCoordinate(0, 1000, 1920)).toBe(0);
    expect(normalizeCoordinate(500, 1000, 1920)).toBe(960);
    expect(normalizeCoordinate(1000, 1000, 1920)).toBe(1919);
    expect(normalizeCoordinate(-100, 1000, 1920)).toBe(0);
    expect(normalizeCoordinate(1500, 1000, 1920)).toBe(1919);
  });

  it('scales and clamps a y coordinate on a 1080 tall screen', () => {
    expect(normalizeCoordinate(0, 1000, 1080)).toBe(0);
    expect(normalizeCoordinate(500, 1000, 1080)).toBe(540);
    expect(normalizeCoordinate(1000, 1000, 1080)).toBe(1079);
    expect(normalizeCoordinate(-100, 1000, 1080)).toBe(0);
    expect(normalizeCoordinate(1500, 1000, 1080)).toBe(1079);
  });

  it('truncates a fractional result rather than rounding it', () => {
    expect(normalizeCoordinate(999, 1000, 1080)).toBe(1078);
    expect(normalizeCoordinate(3, 1000, 1919)).toBe(5);
  });

  it('scales against a 2000x2000 virtual space', () => {
    expect(normalizeCoordinate(1000, 2000, 1920)).toBe(960);
    expect(normalizeCoordinate(2000, 2000, 1920)).toBe(1919);
    expect(normalizeCoordinate(3000, 2000, 1920)).toBe(1919);
    expect(normalizeCoordinate(1000, 2000, 1080)).toBe(540);
    expect(normalizeCoordinate(2000, 2000, 1080)).toBe(1079);
    expect(normalizeCoordinate(3000, 2000, 1080)).toBe(1079);
  });

  it('scales onto a 2560x1440 screen', () => {
    expect(normalizeCoordinate(500, 1000, 2560)).toBe(1280);
    expect(normalizeCoordinate(500, 1000, 1440)).toBe(720);
  });

  it('scales a 2560x1440 screen addressed in an 800x600 space', () => {
    expect(normalizeCoordinate(400, 800, 2560)).toBe(1280);
    expect(normalizeCoordinate(300, 600, 1440)).toBe(720);
    expect(normalizeCoordinate(800, 800, 2560)).toBe(2559);
    expect(normalizeCoordinate(600, 600, 1440)).toBe(1439);
  });
});

describe('normalizeCoordinates', () => {
  it('leaves the caller arguments untouched', () => {
    const args = {x: 500, y: 300, direction: 'down'};

    const normalized = normalizeCoordinates(args, [1920, 1080], [1000, 1000]);

    expect(args).toEqual({x: 500, y: 300, direction: 'down'});
    expect(normalized).toEqual({x: 960, y: 324, direction: 'down'});
  });

  it('reports a non-numeric coordinate by its axis', () => {
    expect(() =>
      normalizeCoordinates({destination_x: 'left'}, [1920, 1080], [1000, 1000]),
    ).toThrow('x coordinate must be numeric, got string');

    expect(() =>
      normalizeCoordinates({destination_y: null}, [1920, 1080], [1000, 1000]),
    ).toThrow('y coordinate must be numeric, got object');
  });
});

describe('toExecuteArguments', () => {
  it('passes a record through', () => {
    const args = {x: 1};

    expect(toExecuteArguments(args)).toBe(args);
  });

  it('replaces a value that is not a record with an empty record', () => {
    expect(toExecuteArguments(null)).toEqual({});
    expect(toExecuteArguments([1, 2])).toEqual({});
    expect(toExecuteArguments('args')).toEqual({});
  });
});

describe('ComputerUseTool.runAsync', () => {
  it('is a function tool', () => {
    expect(isFunctionTool(makeTool(makeDriver('ok')))).toBe(true);
  });

  it('normalizes the coordinates and converts the resulting state', async () => {
    const driver = makeDriver(makeState('https://example.com'));
    const tool = makeTool(driver);

    const result = await tool.runAsync({
      args: {x: 500, y: 300},
      toolContext: makeContext(),
    });

    expect(driver.calls).toEqual([{x: 960, y: 324}]);
    expect(result).toEqual(EXPECTED_IMAGE_PAYLOAD);
  });

  it('normalizes the drag and drop destination', async () => {
    const driver = makeDriver(makeState('https://example.com'));
    const tool = makeTool(driver);

    await tool.runAsync({
      args: {x: 100, y: 200, destination_x: 800, destination_y: 600},
      toolContext: makeContext(),
    });

    expect(driver.calls).toEqual([
      {x: 192, y: 216, destination_x: 1536, destination_y: 648},
    ]);
  });

  it('returns a state without a url', async () => {
    const tool = makeTool(makeDriver(makeState()));

    const result = await tool.runAsync({
      args: {},
      toolContext: makeContext(),
    });

    expect(result).toEqual({
      image: {mimetype: 'image/png', data: SCREENSHOT_BASE64},
      url: undefined,
    });
  });

  it('passes a result that is not a state straight through', async () => {
    const tool = makeTool(makeDriver({status: 'success'}));

    const result = await tool.runAsync({
      args: {text: 'hello'},
      toolContext: makeContext(),
    });

    expect(result).toEqual({status: 'success'});
  });

  it('leaves a non-coordinate argument alone', async () => {
    const driver = makeDriver(makeState('https://example.com'));
    const tool = makeTool(driver);

    await tool.runAsync({
      args: {direction: 'down'},
      toolContext: makeContext(),
    });

    expect(driver.calls).toEqual([{direction: 'down'}]);
  });

  it('rejects a coordinate that is not a number', async () => {
    const driver = makeDriver(makeState('https://example.com'));
    const tool = makeTool(driver);

    await expect(
      tool.runAsync({args: {x: 'invalid'}, toolContext: makeContext()}),
    ).rejects.toThrow(/x coordinate must be numeric/);

    await expect(
      tool.runAsync({args: {y: 'invalid'}, toolContext: makeContext()}),
    ).rejects.toThrow(/y coordinate must be numeric/);

    expect(driver.calls).toEqual([]);
  });

  it('logs and re-throws a driver failure', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const tool = makeTool({
      execute() {
        throw new Error('Test error');
      },
    });

    await expect(
      tool.runAsync({args: {x: 500}, toolContext: makeContext()}),
    ).rejects.toThrow(/Test error/);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Error in ComputerUseTool.runAsync'),
    );
  });

  it('logs each normalized coordinate', async () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const tool = makeTool(makeDriver(makeState('https://example.com')));

    await tool.runAsync({args: {x: 500, y: 300}, toolContext: makeContext()});

    expect(debug).toHaveBeenCalledWith('Normalized x: 500 -> 960');
    expect(debug).toHaveBeenCalledWith('Normalized y: 300 -> 324');
  });
});

describe('ComputerUseTool safety gate', () => {
  it('holds back an action the model flagged, and acts once confirmed', async () => {
    const driver = makeDriver(makeState('https://example.com'));
    const tool = makeTool(driver);
    const args = {safety_decision: {decision: 'require_confirmation'}};

    const context = makeContext({functionCallId: 'test_fc_id'});
    const pending = await tool.runAsync({args, toolContext: context});

    expect(pending).toEqual({
      error: 'This tool call requires confirmation, please approve or reject.',
    });
    expect(context.actions.requestedToolConfirmations['test_fc_id'].hint).toBe(
      DEFAULT_HINT,
    );
    expect(context.actions.skipSummarization).toBe(true);
    expect(driver.calls).toEqual([]);

    const confirmed = makeContext({
      functionCallId: 'test_fc_id',
      toolConfirmation: new ToolConfirmation({confirmed: true}),
    });
    const result = await tool.runAsync({args, toolContext: confirmed});

    expect(driver.calls).toHaveLength(1);
    expect(result).toEqual({
      ...EXPECTED_IMAGE_PAYLOAD,
      safety_acknowledgement: 'true',
    });
  });

  it('refuses an action the human declined', async () => {
    const driver = makeDriver(makeState('https://example.com'));
    const tool = makeTool(driver);

    const result = await tool.runAsync({
      args: {safety_decision: {decision: 'require_confirmation'}},
      toolContext: makeContext({
        functionCallId: 'test_fc_id',
        toolConfirmation: new ToolConfirmation({confirmed: false}),
      }),
    });

    expect(result).toEqual({error: 'This tool call is rejected.'});
    expect(driver.calls).toEqual([]);
  });

  it('uses the explanation the model supplied as the hint', async () => {
    const tool = makeTool(makeDriver(makeState('https://example.com')));
    const explanation =
      "I need you to complete the challenge by clicking the 'I'm not a robot' checkbox.";
    const context = makeContext({functionCallId: 'test_fc_id_dict'});

    await tool.runAsync({
      args: {safety_decision: {explanation, decision: 'require_confirmation'}},
      toolContext: context,
    });

    expect(
      context.actions.requestedToolConfirmations['test_fc_id_dict'].hint,
    ).toBe(explanation);
  });

  it('falls back to the default hint when the explanation is empty', async () => {
    const tool = makeTool(makeDriver(makeState('https://example.com')));
    const context = makeContext({functionCallId: 'test_fc_id'});

    await tool.runAsync({
      args: {
        safety_decision: {explanation: '', decision: 'require_confirmation'},
      },
      toolContext: context,
    });

    expect(context.actions.requestedToolConfirmations['test_fc_id'].hint).toBe(
      DEFAULT_HINT,
    );
  });

  it('acts on a decision that does not require confirmation', async () => {
    const driver = makeDriver({status: 'success'});
    const tool = makeTool(driver);

    const result = await tool.runAsync({
      args: {safety_decision: {decision: 'allow'}},
      toolContext: makeContext({functionCallId: 'test_fc_id'}),
    });

    expect(result).toEqual({status: 'success'});
    expect(driver.calls).toHaveLength(1);
  });

  it('ignores a safety decision that is not an object', async () => {
    const driver = makeDriver({status: 'success'});
    const tool = makeTool(driver);

    const result = await tool.runAsync({
      args: {safety_decision: 'require_confirmation'},
      toolContext: makeContext({functionCallId: 'test_fc_id'}),
    });

    expect(result).toEqual({status: 'success'});
    expect(driver.calls).toHaveLength(1);
  });

  it('wraps a confirmed result that is not an object', async () => {
    const tool = makeTool(makeDriver('ok'));

    const result = await tool.runAsync({
      args: {},
      toolContext: makeContext({
        functionCallId: 'test_fc_id',
        toolConfirmation: new ToolConfirmation({confirmed: true}),
      }),
    });

    expect(result).toEqual({result: 'ok', safety_acknowledgement: 'true'});
  });
});

describe('evaluateSafetyGate', () => {
  it('lets a confirmed call through', () => {
    const context = makeContext({
      functionCallId: 'test_fc_id',
      toolConfirmation: new ToolConfirmation({confirmed: true}),
    });

    expect(evaluateSafetyGate({}, context)).toBeUndefined();
  });
});

describe('ComputerUseTool.processLlmRequest', () => {
  it('registers no declaration', async () => {
    const tool = makeTool(makeDriver('ok'));
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    await tool.processLlmRequest({toolContext: makeContext(), llmRequest});

    expect(llmRequest.toolsDict).toEqual({});
    expect(llmRequest.config).toBeUndefined();
  });
});
