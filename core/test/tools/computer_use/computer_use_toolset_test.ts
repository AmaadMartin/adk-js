/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseComputer,
  ComputerClickArgs,
  ComputerDragArgs,
  ComputerKeyArgs,
  ComputerNavigateArgs,
  ComputerScrollAtArgs,
  ComputerScrollDocumentArgs,
  ComputerState,
  ComputerTypeArgs,
  ComputerUseToolset,
  ComputerWaitArgs,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
} from '@google/adk';
import {Environment} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

class MockComputer extends BaseComputer {
  readonly calls: Array<[string, unknown]> = [];

  async screenSize(): Promise<[number, number]> {
    return [1920, 1080];
  }
  async environment(): Promise<Environment> {
    return Environment.ENVIRONMENT_BROWSER;
  }
  async openWebBrowser(): Promise<ComputerState> {
    this.calls.push(['openWebBrowser', undefined]);
    return {};
  }
  async clickAt(args: ComputerClickArgs): Promise<ComputerState> {
    this.calls.push(['clickAt', args]);
    return {url: 'clicked'};
  }
  async hoverAt(args: ComputerClickArgs): Promise<ComputerState> {
    this.calls.push(['hoverAt', args]);
    return {};
  }
  async typeTextAt(args: ComputerTypeArgs): Promise<ComputerState> {
    this.calls.push(['typeTextAt', args]);
    return {};
  }
  async scrollDocument(
    args: ComputerScrollDocumentArgs,
  ): Promise<ComputerState> {
    this.calls.push(['scrollDocument', args]);
    return {};
  }
  async scrollAt(args: ComputerScrollAtArgs): Promise<ComputerState> {
    this.calls.push(['scrollAt', args]);
    return {};
  }
  async wait(args: ComputerWaitArgs): Promise<ComputerState> {
    this.calls.push(['wait', args]);
    return {};
  }
  async goBack(): Promise<ComputerState> {
    this.calls.push(['goBack', undefined]);
    return {};
  }
  async goForward(): Promise<ComputerState> {
    this.calls.push(['goForward', undefined]);
    return {};
  }
  async search(): Promise<ComputerState> {
    this.calls.push(['search', undefined]);
    return {};
  }
  async navigate(args: ComputerNavigateArgs): Promise<ComputerState> {
    this.calls.push(['navigate', args]);
    return {};
  }
  async keyCombination(args: ComputerKeyArgs): Promise<ComputerState> {
    this.calls.push(['keyCombination', args]);
    return {};
  }
  async dragAndDrop(args: ComputerDragArgs): Promise<ComputerState> {
    this.calls.push(['dragAndDrop', args]);
    return {};
  }
  async currentState(): Promise<ComputerState> {
    this.calls.push(['currentState', undefined]);
    return {};
  }

  /** A helper a real implementation might add; never a model-facing tool. */
  async authenticate(): Promise<void> {}
}

/** Valid model arguments for every predefined action, keyed by tool name. */
const ARGS_BY_TOOL_NAME: Readonly<Record<string, Record<string, unknown>>> = {
  open_web_browser: {},
  click_at: {x: 500, y: 500},
  hover_at: {x: 500, y: 500},
  type_text_at: {x: 500, y: 500, text: 'hello'},
  scroll_document: {direction: 'down'},
  scroll_at: {x: 500, y: 500, direction: 'up', magnitude: 3},
  wait: {seconds: 1},
  go_back: {},
  go_forward: {},
  search: {},
  navigate: {url: 'https://example.com'},
  key_combination: {keys: ['ctrl', 'c']},
  drag_and_drop: {x: 100, y: 100, destination_x: 200, destination_y: 200},
  current_state: {},
};

function createToolContext(): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'computer_use_test_agent'}),
    session: createSession({id: 'test', appName: 'computer-use-test'}),
    pluginManager: new PluginManager([]),
  });

  return new Context({invocationContext, functionCallId: 'test-call'});
}

function createLlmRequest(): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}};
}

describe('ComputerUseToolset', () => {
  let computer: MockComputer;
  let toolset: ComputerUseToolset;
  let context: Context;

  beforeEach(() => {
    computer = new MockComputer();
    toolset = new ComputerUseToolset({
      computer,
      excludedPredefinedFunctions: ['hoverAt'],
    });
    context = createToolContext();
  });

  afterEach(async () => {
    await toolset.close();
  });

  it('generates a tool per predefined computer action, excluding specified ones', async () => {
    const tools = await toolset.getTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toContain('click_at');
    expect(toolNames).toContain('type_text_at');
    expect(toolNames).toContain('drag_and_drop');

    // hoverAt excluded
    expect(toolNames).not.toContain('hover_at');

    // built-in lifecycle and config excluded
    expect(toolNames).not.toContain('screen_size');
    expect(toolNames).not.toContain('environment');
    expect(toolNames).not.toContain('initialize');
  });

  it('routes every generated tool to its computer method', async () => {
    const fullToolset = new ComputerUseToolset({computer});
    const tools = await fullToolset.getTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      Object.keys(ARGS_BY_TOOL_NAME).sort(),
    );

    for (const tool of tools) {
      await tool.runAsync({
        args: {...ARGS_BY_TOOL_NAME[tool.name]},
        toolContext: context,
      });
    }

    expect(computer.calls).toHaveLength(tools.length);
  });

  it('does not expose helper methods a subclass happens to define', async () => {
    const toolNames = (await toolset.getTools()).map((tool) => tool.name);

    expect(toolNames).not.toContain('authenticate');
  });

  it('wraps execution by calling prepare and then the instance method', async () => {
    vi.spyOn(computer, 'prepare');

    const tools = await toolset.getTools();
    const clickTool = tools.find((tool) => tool.name === 'click_at');

    expect(clickTool).toBeDefined();

    const response = await clickTool!.runAsync({
      args: {x: 1000, y: 1000},
      toolContext: context,
    });

    expect(computer.prepare).toHaveBeenCalledWith(context);
    expect(computer.calls).toEqual([['clickAt', {x: 1919, y: 1079}]]);
    expect(response).toEqual({url: 'clicked'});
  });

  it('passes only the declared arguments to the computer method', async () => {
    const tools = await toolset.getTools();
    const typeTool = tools.find((tool) => tool.name === 'type_text_at');

    await typeTool!.runAsync({
      args: {
        x: 500,
        y: 500,
        text: 'hello',
        press_enter: true,
        safety_decision: {decision: 'allow'},
      },
      toolContext: context,
    });

    expect(computer.calls).toEqual([
      [
        'typeTextAt',
        {
          x: 960,
          y: 540,
          text: 'hello',
          press_enter: true,
          clear_before_typing: undefined,
        },
      ],
    ]);
  });

  it('rejects arguments that do not match the action signature', async () => {
    const tools = await toolset.getTools();
    const scrollTool = tools.find((tool) => tool.name === 'scroll_document');
    const keysTool = tools.find((tool) => tool.name === 'key_combination');
    const waitTool = tools.find((tool) => tool.name === 'wait');

    await expect(
      scrollTool!.runAsync({
        args: {direction: 'sideways'},
        toolContext: context,
      }),
    ).rejects.toThrowError(/"direction" must be one of/);

    await expect(
      keysTool!.runAsync({args: {keys: ['ctrl', 3]}, toolContext: context}),
    ).rejects.toThrowError(/"keys\[1\]" must be a string/);

    await expect(
      waitTool!.runAsync({args: {}, toolContext: context}),
    ).rejects.toThrowError(/"seconds" must be a number/);
  });

  it('modifies llmRequest config with computerUse natively', async () => {
    const llmRequest = createLlmRequest();

    await toolset.processLlmRequest(context, llmRequest);

    expect(llmRequest.toolsDict['click_at']).toBeDefined();
    expect(llmRequest.toolsDict['type_text_at']).toBeDefined();

    expect(llmRequest.config?.tools).toEqual([
      {
        computerUse: {
          environment: Environment.ENVIRONMENT_BROWSER,
          excludedPredefinedFunctions: ['hoverAt'],
        },
      },
    ]);
  });

  it('skips modifying config if computerUse is already present', async () => {
    const llmRequest: LlmRequest = {
      ...createLlmRequest(),
      config: {tools: [{computerUse: {}}]},
    };

    await toolset.processLlmRequest(context, llmRequest);
    expect(llmRequest.config?.tools?.length).toBe(1);
    expect(llmRequest.toolsDict['click_at']).toBeDefined();
  });

  it('rejects processLlmRequest if computer environment throws', async () => {
    const llmRequest = createLlmRequest();
    vi.spyOn(computer, 'environment').mockRejectedValue(new Error('env error'));

    await expect(
      toolset.processLlmRequest(context, llmRequest),
    ).rejects.toThrowError('env error');
  });

  it('returns cached tools on subsequent getTools calls', async () => {
    const tools1 = await toolset.getTools();
    const tools2 = await toolset.getTools();
    expect(tools1).toBe(tools2);
  });

  it('closes the underlying computer', async () => {
    vi.spyOn(computer, 'close');
    await toolset.close();
    expect(computer.close).toHaveBeenCalled();
  });
});
