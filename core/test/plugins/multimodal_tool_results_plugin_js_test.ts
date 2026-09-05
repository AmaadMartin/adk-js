/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// The TypeScript-specific surface of MultimodalToolResultsPlugin. The tests
// ported from adk-python live in multimodal_tool_results_plugin_test.ts.

import {
  Context,
  createSession,
  FunctionTool,
  InvocationContext,
  LlmRequest,
  MultimodalToolResultsPlugin,
  PARTS_RETURNED_BY_TOOLS_ID,
  PluginManager,
  SESSION_PARTS_RETURNED_BY_TOOLS_ID,
} from '@google/adk';
import {Content, Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {CURRENT_TURN_PARTS_ID} from '../../src/plugins/multimodal_tool_results_plugin.js';

const TEST_TOOL = new FunctionTool({
  name: 'test_tool',
  description: 'a tool used only to satisfy the callback signature',
  execute: async () => ({}),
});

const FILE_PART: Part = {
  fileData: {fileUri: 'gs://bucket/doc.pdf', mimeType: 'application/pdf'},
};

/** A part carrying an explicitly `undefined` field, as a live object does. */
const SPARSE_PART: Part = {
  fileData: {fileUri: 'gs://bucket/report.pdf', mimeType: 'application/pdf'},
  thought: undefined,
};

function createContext(sessionState: Record<string, unknown> = {}): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({
        id: 'session-1',
        appName: 'test-app',
        userId: 'user-1',
        state: sessionState,
      }),
      pluginManager: new PluginManager([]),
    }),
  });
}

function callAfterTool(
  plugin: MultimodalToolResultsPlugin,
  toolContext: Context,
  result: unknown,
): Promise<Record<string, unknown> | undefined> {
  return plugin.afterToolCallback({
    tool: TEST_TOOL,
    toolArgs: {},
    toolContext,
    result,
  });
}

function createRequest(contents: Content[]): LlmRequest {
  return {contents, toolsDict: {}, liveConnectConfig: {}};
}

describe('MultimodalToolResultsPlugin part detection', () => {
  it('treats a single part as parts', async () => {
    const plugin = new MultimodalToolResultsPlugin();
    const toolContext = createContext();

    const result = await callAfterTool(plugin, toolContext, FILE_PART);

    expect(result).toBeUndefined();
    expect(toolContext.state.get(PARTS_RETURNED_BY_TOOLS_ID)).toEqual([
      FILE_PART,
    ]);
  });

  it.each([
    ['an empty array', []],
    ['an array of plain objects', [{result: 42}]],
    ['null', null],
    ['a string', 'done'],
    ['a number', 42],
    ['a plain record', {result: 42}],
  ])('returns %s unchanged', async (_label, raw) => {
    const plugin = new MultimodalToolResultsPlugin();
    const toolContext = createContext();

    const result = await callAfterTool(plugin, toolContext, raw);

    expect(result).toBe(raw);
    expect(toolContext.state.has(PARTS_RETURNED_BY_TOOLS_ID)).toBe(false);
  });

  it('ignores a part-shaped object whose only part field is undefined', async () => {
    const plugin = new MultimodalToolResultsPlugin();
    const toolContext = createContext();
    const raw = {text: undefined};

    const result = await callAfterTool(plugin, toolContext, raw);

    expect(result).toBe(raw);
    expect(toolContext.state.has(PARTS_RETURNED_BY_TOOLS_ID)).toBe(false);
  });
});

describe('MultimodalToolResultsPlugin construction', () => {
  it('defaults the name to multimodal_tool_results_plugin', () => {
    expect(new MultimodalToolResultsPlugin().name).toBe(
      'multimodal_tool_results_plugin',
    );
  });

  it('honours a custom name', () => {
    expect(new MultimodalToolResultsPlugin({name: 'custom'}).name).toBe(
      'custom',
    );
  });

  it('defaults the retention to next_model_call', async () => {
    const plugin = new MultimodalToolResultsPlugin();
    const toolContext = createContext();

    await callAfterTool(plugin, toolContext, [FILE_PART]);

    expect(toolContext.state.has(PARTS_RETURNED_BY_TOOLS_ID)).toBe(true);
    expect(toolContext.state.has(SESSION_PARTS_RETURNED_BY_TOOLS_ID)).toBe(
      false,
    );
  });

  it.each(['next_model_call', 'session'] as const)(
    'accepts the %s retention',
    (retention) => {
      expect(() => new MultimodalToolResultsPlugin({retention})).not.toThrow();
    },
  );
});

describe('MultimodalToolResultsPlugin request handling', () => {
  it('initialises a missing parts array on the last content', async () => {
    const plugin = new MultimodalToolResultsPlugin();
    const toolContext = createContext();
    await callAfterTool(plugin, toolContext, [FILE_PART]);
    const llmRequest = createRequest([{role: 'user'}]);

    await plugin.beforeModelCallback({
      callbackContext: toolContext,
      llmRequest,
    });

    expect(llmRequest.contents[0].parts).toEqual([FILE_PART]);
  });

  it('leaves the request alone when no tool returned parts', async () => {
    const plugin = new MultimodalToolResultsPlugin();
    const llmRequest = createRequest([{parts: [{text: 'hi'}]}]);

    const response = await plugin.beforeModelCallback({
      callbackContext: createContext(),
      llmRequest,
    });

    expect(response).toBeUndefined();
    expect(llmRequest.contents[0].parts).toEqual([{text: 'hi'}]);
  });

  it('leaves the request alone in session retention when nothing is saved', async () => {
    const plugin = new MultimodalToolResultsPlugin({retention: 'session'});
    const toolContext = createContext();
    const llmRequest = createRequest([{parts: [{text: 'hi'}]}]);

    await plugin.beforeModelCallback({
      callbackContext: toolContext,
      llmRequest,
    });

    expect(llmRequest.contents[0].parts).toEqual([{text: 'hi'}]);
    expect(toolContext.state.has(CURRENT_TURN_PARTS_ID)).toBe(false);
  });

  it('attaches to the last content only', async () => {
    const plugin = new MultimodalToolResultsPlugin();
    const toolContext = createContext();
    await callAfterTool(plugin, toolContext, [FILE_PART]);
    const llmRequest = createRequest([
      {parts: [{text: 'first'}]},
      {parts: [{text: 'last'}]},
    ]);

    await plugin.beforeModelCallback({
      callbackContext: toolContext,
      llmRequest,
    });

    expect(llmRequest.contents[0].parts).toEqual([{text: 'first'}]);
    expect(llmRequest.contents[1].parts).toEqual([{text: 'last'}, FILE_PART]);
  });
});

describe('MultimodalToolResultsPlugin session serialisation', () => {
  it('de-duplicates a saved part that survived a JSON round trip', async () => {
    const plugin = new MultimodalToolResultsPlugin({retention: 'session'});
    const sessionState: Record<string, unknown> = {};
    await callAfterTool(plugin, createContext(sessionState), [SPARSE_PART]);

    // The stored state is what a real session service writes and reads back.
    const revived: Record<string, unknown> = JSON.parse(
      JSON.stringify(sessionState),
    );
    const llmRequest = createRequest([{parts: []}]);

    await plugin.beforeModelCallback({
      callbackContext: createContext(revived),
      llmRequest,
    });

    expect(llmRequest.contents[0].parts).toHaveLength(1);
    expect(llmRequest.contents[0].parts).toEqual([SPARSE_PART]);
  });
});
