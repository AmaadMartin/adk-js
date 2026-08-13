/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end test that exercises MultimodalToolResultsPlugin against the real
 * ADK runtime objects (a real InvocationContext, the delta-aware State, and a
 * real LlmRequest) with no mocks. The same session state is shared across
 * afterToolCallback and beforeModelCallback, mirroring how the Runner threads
 * the invocation's state through the tool and model callbacks within a turn.
 */

import {
  BaseAgent,
  BaseTool,
  Context,
  InvocationContext,
  LlmRequest,
  MultimodalToolResultsPlugin,
  PARTS_RETURNED_BY_TOOLS_ID,
  PluginManager,
  Session,
} from '@google/adk';
import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

function createContext(): Context {
  const session = {
    id: 'session-1',
    appName: 'app',
    userId: 'user',
    state: {},
    events: [],
    lastUpdateTime: Date.now(),
  } as Session;

  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    session,
    agent: {} as BaseAgent,
    pluginManager: {} as PluginManager,
  });

  return new Context({invocationContext});
}

const echoTool = {name: 'image_tool'} as BaseTool;

describe('MultimodalToolResultsPlugin (e2e, real Context/State)', () => {
  it('injects a tool-returned image part into the next LlmRequest', async () => {
    const plugin = new MultimodalToolResultsPlugin();
    const context = createContext();

    const imagePart: Part = {
      inlineData: {mimeType: 'image/png', data: 'aGVsbG8='},
    };

    // The tool returns a genai Part; the plugin stashes it and keeps the
    // original result (returns undefined).
    const afterResult = await plugin.afterToolCallback({
      tool: echoTool,
      toolArgs: {},
      toolContext: context,
      result: imagePart as unknown as Record<string, unknown>,
    });
    expect(afterResult).toBeUndefined();
    expect(context.state.get<Part[]>(PARTS_RETURNED_BY_TOOLS_ID)).toEqual([
      imagePart,
    ]);

    // The next model request should have the image appended to its final
    // content, and the buffer should be drained.
    const llmRequest: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'describe the image'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };

    const modelResult = await plugin.beforeModelCallback({
      callbackContext: context,
      llmRequest,
    });

    expect(modelResult).toBeUndefined();
    expect(llmRequest.contents[0].parts).toEqual([
      {text: 'describe the image'},
      imagePart,
    ]);
    expect(context.state.get<Part[]>(PARTS_RETURNED_BY_TOOLS_ID)).toEqual([]);
  });
});
