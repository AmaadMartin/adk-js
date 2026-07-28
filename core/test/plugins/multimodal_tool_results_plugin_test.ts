/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Context,
  LlmRequest,
  MultimodalToolResultsPlugin,
  PARTS_RETURNED_BY_TOOLS_ID,
} from '@google/adk';
import {Content, Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

/**
 * Builds a fake `Context` whose `state` is a `{get, set}` facade over a shared
 * store. The same store is reused across `afterToolCallback` and
 * `beforeModelCallback` in a scenario, mirroring adk-python where the callback
 * context and tool context share state.
 */
function makeContext(initialState: Record<string, unknown> = {}): {
  context: Context;
  stateStore: Record<string, unknown>;
} {
  const stateStore: Record<string, unknown> = {...initialState};
  const context = {
    state: {
      get: (key: string) => stateStore[key],
      set: (key: string, value: unknown) => {
        stateStore[key] = value;
      },
    },
  } as unknown as Context;
  return {context, stateStore};
}

function makeRequest(contents: Content[] | undefined): LlmRequest {
  return {contents} as unknown as LlmRequest;
}

const mockTool = {name: 'test_tool'} as BaseTool;

async function callAfterTool(
  plugin: MultimodalToolResultsPlugin,
  context: Context,
  result: unknown,
): Promise<Record<string, unknown> | undefined> {
  return plugin.afterToolCallback({
    tool: mockTool,
    toolArgs: {},
    toolContext: context,
    result: result as Record<string, unknown>,
  });
}

describe('MultimodalToolResultsPlugin', () => {
  describe('constructor', () => {
    it('uses the default name', () => {
      const plugin = new MultimodalToolResultsPlugin();
      expect(plugin.name).toBe('multimodal_tool_results_plugin');
    });

    it('honors a custom name', () => {
      const plugin = new MultimodalToolResultsPlugin('custom_name');
      expect(plugin.name).toBe('custom_name');
    });
  });

  describe('afterToolCallback', () => {
    it('stashes an array of parts and returns undefined', async () => {
      const plugin = new MultimodalToolResultsPlugin();
      const {context, stateStore} = makeContext();
      const parts: Part[] = [{text: 'part1'}, {text: 'part2'}];

      const result = await callAfterTool(plugin, context, parts);

      expect(result).toBeUndefined();
      expect(stateStore[PARTS_RETURNED_BY_TOOLS_ID]).toEqual(parts);
    });

    it('stashes a single (non-array) part wrapped in an array', async () => {
      const plugin = new MultimodalToolResultsPlugin();
      const {context, stateStore} = makeContext();
      const part: Part = {text: 'p'};

      const result = await callAfterTool(plugin, context, part);

      expect(result).toBeUndefined();
      expect(stateStore[PARTS_RETURNED_BY_TOOLS_ID]).toEqual([part]);
    });

    it('accumulates parts across multiple calls', async () => {
      const plugin = new MultimodalToolResultsPlugin();
      const {context, stateStore} = makeContext();

      await callAfterTool(plugin, context, [{text: 'part1'}]);
      await callAfterTool(plugin, context, [{text: 'part2'}]);

      expect(stateStore[PARTS_RETURNED_BY_TOOLS_ID]).toEqual([
        {text: 'part1'},
        {text: 'part2'},
      ]);
    });

    // Each input exercises a distinct non-part branch of isPart: a plain
    // object, an empty array, an array of non-part objects, an array whose
    // first element is a primitive, and an array whose first element is null.
    it.each([
      {name: 'a plain object', input: {some: 'data'}},
      {name: 'an empty array', input: [] as unknown[]},
      {name: 'an array of non-part objects', input: [{some: 'data'}]},
      {name: 'an array whose first element is a primitive', input: ['x']},
      {name: 'an array whose first element is null', input: [null]},
    ])('returns $name unchanged and does not touch state', async ({input}) => {
      const plugin = new MultimodalToolResultsPlugin();
      const {context, stateStore} = makeContext();

      const result = await callAfterTool(plugin, context, input);

      expect(result).toBe(input);
      expect(PARTS_RETURNED_BY_TOOLS_ID in stateStore).toBe(false);
    });
  });

  describe('beforeModelCallback', () => {
    it('flushes saved parts onto the last content and clears the buffer', async () => {
      const plugin = new MultimodalToolResultsPlugin();
      const {context, stateStore} = makeContext();
      const parts: Part[] = [{text: 'part1'}, {text: 'part2'}];
      await callAfterTool(plugin, context, parts);

      const llmRequest = makeRequest([{parts: []}]);
      const response = await plugin.beforeModelCallback({
        callbackContext: context,
        llmRequest,
      });

      expect(response).toBeUndefined();
      expect(llmRequest.contents[0].parts).toEqual(parts);
      expect(stateStore[PARTS_RETURNED_BY_TOOLS_ID]).toEqual([]);
    });

    it('appends saved parts after existing parts on the last content', async () => {
      const plugin = new MultimodalToolResultsPlugin();
      const {context} = makeContext();
      await callAfterTool(plugin, context, [{text: 'saved'}]);

      const llmRequest = makeRequest([{parts: [{text: 'orig'}]}]);
      await plugin.beforeModelCallback({callbackContext: context, llmRequest});

      expect(llmRequest.contents[0].parts).toEqual([
        {text: 'orig'},
        {text: 'saved'},
      ]);
    });

    it('flushes onto a last content that has no parts field', async () => {
      const plugin = new MultimodalToolResultsPlugin();
      const {context} = makeContext();
      await callAfterTool(plugin, context, [{text: 'saved'}]);

      const llmRequest = makeRequest([{}]);
      await plugin.beforeModelCallback({callbackContext: context, llmRequest});

      expect(llmRequest.contents[0].parts).toEqual([{text: 'saved'}]);
    });

    it('accumulated parts from multiple tools are flushed together', async () => {
      const plugin = new MultimodalToolResultsPlugin();
      const {context} = makeContext();
      await callAfterTool(plugin, context, [{text: 'part1'}]);
      await callAfterTool(plugin, context, [{text: 'part2'}]);

      const llmRequest = makeRequest([{parts: []}]);
      await plugin.beforeModelCallback({callbackContext: context, llmRequest});

      expect(llmRequest.contents[0].parts).toEqual([
        {text: 'part1'},
        {text: 'part2'},
      ]);
    });

    // Both branches of the `!contents || contents.length === 0` guard leave the
    // buffered parts pending (not flushed) and return undefined.
    it.each([
      {name: 'empty', contents: [] as Content[]},
      {name: 'absent', contents: undefined},
    ])(
      'is a no-op and keeps parts pending when contents is $name',
      async ({contents}) => {
        const plugin = new MultimodalToolResultsPlugin();
        const {context, stateStore} = makeContext();
        const parts: Part[] = [{text: 'part1'}];
        await callAfterTool(plugin, context, parts);

        const llmRequest = makeRequest(contents);
        const response = await plugin.beforeModelCallback({
          callbackContext: context,
          llmRequest,
        });

        expect(response).toBeUndefined();
        expect(stateStore[PARTS_RETURNED_BY_TOOLS_ID]).toEqual(parts);
      },
    );

    // Both branches of the `savedParts && savedParts.length > 0` gate (no buffer
    // vs an empty buffer) leave existing contents untouched.
    it.each([
      {name: 'there are no saved parts', initial: {}},
      {
        name: 'the buffer is empty',
        initial: {[PARTS_RETURNED_BY_TOOLS_ID]: []},
      },
    ])('does not mutate contents when $name', async ({initial}) => {
      const plugin = new MultimodalToolResultsPlugin();
      const {context} = makeContext(initial);

      const llmRequest = makeRequest([{parts: [{text: 'keep'}]}]);
      const response = await plugin.beforeModelCallback({
        callbackContext: context,
        llmRequest,
      });

      expect(response).toBeUndefined();
      expect(llmRequest.contents[0].parts).toEqual([{text: 'keep'}]);
    });
  });
});
