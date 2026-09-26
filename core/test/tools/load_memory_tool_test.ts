/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {
  Context,
  LlmRequest,
  LOAD_MEMORY,
  LoadMemoryTool,
  MemoryEntry,
  SearchMemoryResponse,
} from '@google/adk';

class StubToolContext {
  private memories: MemoryEntry[];

  constructor(memories: MemoryEntry[]) {
    this.memories = memories;
  }

  // Minimal stub properties needed to bypass initialized checks
  invocationContext = {
    // Just needs to exist
    memoryService: {},
  };

  async searchMemory(_query: string): Promise<SearchMemoryResponse> {
    return {memories: this.memories};
  }
}

/**
 * `Context` is a class, so a partial stub cannot satisfy it structurally. The
 * cast is confined here instead of repeated at every call site.
 */
function stubContext(memories: MemoryEntry[]): Context {
  return new StubToolContext(memories) as unknown as Context;
}

describe('LoadMemoryTool', () => {
  it('computes the correct declaration', () => {
    const tool = new LoadMemoryTool();
    const declaration = tool._getDeclaration();

    expect(declaration?.name).toEqual('load_memory');
    expect(declaration?.description).toContain(
      'Loads the memory for the current user.',
    );
    expect(declaration?.parameters).toEqual({
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'The query to load the memory for.',
        },
      },
      required: ['query'],
    });
  });

  it('sets correct response on runAsync', async () => {
    const tool = new LoadMemoryTool();
    const mockContext = stubContext([
      {
        content: {role: 'user', parts: [{text: 'hi'}]},
        author: 'someone',
      },
    ]);

    const result = await tool.runAsync({
      args: {query: 'hello'},
      toolContext: mockContext,
    });

    expect(result).toEqual({
      memories: [
        {
          content: 'hi',
          author: 'someone',
          timestamp: undefined,
        },
      ],
    });
  });

  it('drops text-free parts from the memory content', async () => {
    const tool = new LoadMemoryTool();
    const mockContext = stubContext([
      {
        content: {
          role: 'user',
          parts: [
            {text: 'a'},
            {inlineData: {mimeType: 'image/png', data: 'AAAA'}},
            {text: 'b'},
          ],
        },
      },
      {
        content: {
          role: 'user',
          parts: [
            {inlineData: {mimeType: 'image/png', data: 'AAAA'}},
            {functionCall: {name: 'lookup', args: {}}},
          ],
        },
      },
    ]);

    const result = await tool.runAsync({
      args: {query: 'hello'},
      toolContext: mockContext,
    });

    expect(result).toEqual({
      memories: [
        {content: 'a b', author: undefined, timestamp: undefined},
        {content: '', author: undefined, timestamp: undefined},
      ],
    });
  });

  it('has a global instance LOAD_MEMORY', () => {
    expect(LOAD_MEMORY).toBeInstanceOf(LoadMemoryTool);
  });

  it('throws error if memoryService is not initialized', async () => {
    const tool = new LoadMemoryTool();
    const mockContext = stubContext([]);
    (mockContext.invocationContext as {memoryService?: unknown}).memoryService =
      undefined;

    await expect(
      tool.runAsync({
        args: {query: 'hello'},
        toolContext: mockContext,
      }),
    ).rejects.toThrow('Memory service is not initialized.');
  });

  it('does not append instruction if memoryService is missing in context', async () => {
    const toolContext = stubContext([]);
    (toolContext.invocationContext as {memoryService?: unknown}).memoryService =
      undefined;

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    const tool = new LoadMemoryTool();
    await tool.processLlmRequest({toolContext, llmRequest});
    // System instructions should NOT be appended.
    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });

  it('appends system instructions if memoryService is present in context', async () => {
    const toolContext = stubContext([]);

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    const tool = new LoadMemoryTool();
    await tool.processLlmRequest({toolContext, llmRequest});
    // Instructions should be appended
    expect(llmRequest.config?.systemInstruction).toContain('You have memory.');
  });
});
