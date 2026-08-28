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

  invocationContext: {memoryService?: unknown} = {memoryService: {}};

  async searchMemory(_query: string): Promise<SearchMemoryResponse> {
    // Mirrors Context.searchMemory, which raises before it reaches a service.
    if (!this.invocationContext.memoryService) {
      throw new Error('Memory service is not initialized.');
    }
    return {memories: this.memories};
  }
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
    const mockContext = new StubToolContext([
      {
        content: {role: 'user', parts: [{text: 'hi'}]},
        author: 'someone',
      },
    ]) as unknown as Context;

    const result = await tool.runAsync({
      args: {query: 'hello'},
      toolContext: mockContext,
    });

    expect(result).toEqual({
      memories: [
        {
          content: {role: 'user', parts: [{text: 'hi'}]},
          author: 'someone',
        },
      ],
    });
  });

  it('has a global instance LOAD_MEMORY', () => {
    expect(LOAD_MEMORY).toBeInstanceOf(LoadMemoryTool);
  });

  it('throws error if memoryService is not initialized', async () => {
    const tool = new LoadMemoryTool();
    const stub = new StubToolContext([]);
    stub.invocationContext.memoryService = undefined;

    await expect(
      tool.runAsync({
        args: {query: 'hello'},
        toolContext: stub as unknown as Context,
      }),
    ).rejects.toThrow('Memory service is not initialized.');
  });

  it('appends system instructions if memoryService is present in context', async () => {
    const toolContext = new StubToolContext([]) as unknown as Context;

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
