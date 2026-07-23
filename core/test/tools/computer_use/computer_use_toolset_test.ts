/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {Context} from '../../../src/agents/context.js';
import {LlmRequest} from '../../../src/models/llm_request.js';
import {createSession} from '../../../src/sessions/session.js';
import {
  BaseComputer,
  ComputerEnvironment,
  ComputerState,
} from '../../../src/tools/computer_use/base_computer.js';
import {ComputerUseTool} from '../../../src/tools/computer_use/computer_use_tool.js';
import {ComputerUseToolset} from '../../../src/tools/computer_use/computer_use_toolset.js';

class MockComputer extends BaseComputer {
  async screenSize(): Promise<[number, number]> {
    return [1920, 1080];
  }
  async environment(): Promise<ComputerEnvironment> {
    return ComputerEnvironment.ENVIRONMENT_BROWSER;
  }
  async openWebBrowser(): Promise<ComputerState> {
    return {};
  }
  async clickAt(): Promise<ComputerState> {
    return {url: 'clicked'};
  }
  async hoverAt(): Promise<ComputerState> {
    return {};
  }
  async typeTextAt(): Promise<ComputerState> {
    return {};
  }
  async scrollDocument(): Promise<ComputerState> {
    return {};
  }
  async scrollAt(): Promise<ComputerState> {
    return {};
  }
  async wait(): Promise<ComputerState> {
    return {};
  }
  async goBack(): Promise<ComputerState> {
    return {};
  }
  async goForward(): Promise<ComputerState> {
    return {};
  }
  async search(): Promise<ComputerState> {
    return {};
  }
  async navigate(): Promise<ComputerState> {
    return {};
  }
  async keyCombination(): Promise<ComputerState> {
    return {};
  }
  async dragAndDrop(): Promise<ComputerState> {
    return {};
  }
  async currentState(): Promise<ComputerState> {
    return {};
  }

  async customMethod(): Promise<ComputerState> {
    return {};
  }
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
    context = new Context({
      invocationContext: {
        session: createSession('test'),
      } as any,
    });
  });

  afterEach(async () => {
    await toolset.close();
  });

  it('generates tools dynamically based on BaseComputer methods, excluding specified ones', async () => {
    const tools = await toolset.getTools();
    const toolNames = tools.map((t: ComputerUseTool) => t.name);

    expect(toolNames).toContain('click_at');
    expect(toolNames).toContain('type_text_at');
    expect(toolNames).toContain('custom_method');

    // hoverAt excluded
    expect(toolNames).not.toContain('hover_at');

    // built-in lifecycle and config excluded
    expect(toolNames).not.toContain('screen_size');
    expect(toolNames).not.toContain('environment');
    expect(toolNames).not.toContain('initialize');
  });

  it('wraps execution by calling prepare and then the instance method', async () => {
    vi.spyOn(computer, 'prepare');
    vi.spyOn(computer, 'clickAt');

    const tools = await toolset.getTools();
    const clickTool = tools.find((t) => t.name === 'click_at')!;

    expect(clickTool).toBeDefined();

    const response = await clickTool.runAsync({
      args: {x: 1000, y: 1000},
      toolContext: context,
    });

    expect(computer.prepare).toHaveBeenCalledWith(context);
    expect(computer.clickAt).toHaveBeenCalledWith(
      expect.objectContaining({x: 1919, y: 1079}),
    );
    expect((response as any).url).toBe('clicked');
  });

  it('modifies llmRequest config with computerUse natively', async () => {
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    await toolset.processLlmRequest(context, llmRequest);

    expect(llmRequest.toolsDict['click_at']).toBeDefined();
    expect(llmRequest.toolsDict['type_text_at']).toBeDefined();

    expect(llmRequest.config?.tools?.length).toBeGreaterThan(0);
    const computerUseConfig = (llmRequest.config!.tools![0] as any).computerUse;
    expect(computerUseConfig).toBeDefined();
    expect(computerUseConfig.environment).toBe(
      ComputerEnvironment.ENVIRONMENT_BROWSER,
    );
    expect(computerUseConfig.excludedPredefinedFunctions).toEqual(['hoverAt']);
  });

  it('skips modifying config if computerUse is already present', async () => {
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {
        tools: [{computerUse: {}} as any],
      },
    } as LlmRequest;

    await toolset.processLlmRequest(context, llmRequest);
    expect(llmRequest.config?.tools?.length).toBe(1);
    expect(llmRequest.toolsDict['click_at']).toBeDefined();
  });

  it('rejects processLlmRequest if computer environment throws', async () => {
    const llmRequest: LlmRequest = {contents: [], toolsDict: {}} as any;
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

  it('scans BaseComputer prototype for additional methods', async () => {
    try {
      (BaseComputer.prototype as any).aNewBaseMethod = function () {};

      const tl = await toolset.getTools();
      expect(tl.find((t) => t.name === 'a_new_base_method')).toBeDefined();
    } finally {
      delete (BaseComputer.prototype as any).aNewBaseMethod;
    }
  });
});
