/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {
  Context,
  FeatureName,
  LlmRequest,
  LOAD_MEMORY,
  LoadMemoryTool,
  MemoryEntry,
  SearchMemoryResponse,
  withTemporaryFeatureOverride,
} from '@google/adk';

const MISSING_QUERY_ERROR =
  'Invoking `load_memory()` failed as the following mandatory input parameters are not present:\n' +
  'query\n' +
  'You could retry calling this tool, but it is IMPORTANT for you to provide all the mandatory parameters.';

class StubToolContext {
  private memories: MemoryEntry[];

  /** Every query the tool searched for, in call order. */
  readonly queries: string[] = [];

  constructor(memories: MemoryEntry[]) {
    this.memories = memories;
  }

  invocationContext: {memoryService?: unknown} = {memoryService: {}};

  async searchMemory(query: string): Promise<SearchMemoryResponse> {
    // Mirrors Context.searchMemory, which raises before it reaches a service.
    if (!this.invocationContext.memoryService) {
      throw new Error('Memory service is not initialized.');
    }
    this.queries.push(query);
    return {memories: this.memories};
  }
}

function createLlmRequest(): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}};
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

  it('declares a Schema when JSON_SCHEMA_FOR_FUNC_DECL is disabled', async () => {
    const tool = new LoadMemoryTool();

    const declaration = await withTemporaryFeatureOverride(
      FeatureName.JSON_SCHEMA_FOR_FUNC_DECL,
      false,
      () => tool._getDeclaration(),
    );

    expect(declaration?.name).toEqual('load_memory');
    expect(declaration?.parametersJsonSchema).toBeUndefined();
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

  it('declares a JSON Schema when JSON_SCHEMA_FOR_FUNC_DECL is enabled', async () => {
    const tool = new LoadMemoryTool();

    const declaration = await withTemporaryFeatureOverride(
      FeatureName.JSON_SCHEMA_FOR_FUNC_DECL,
      true,
      () => tool._getDeclaration(),
    );

    expect(declaration?.name).toEqual('load_memory');
    expect(declaration?.parameters).toBeUndefined();
    expect(declaration?.parametersJsonSchema).toEqual({
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The query to load the memory for.',
        },
      },
      required: ['query'],
    });
  });

  it('registers itself in the request tools so the model can call it', async () => {
    const toolContext = new StubToolContext([]) as unknown as Context;
    const llmRequest = createLlmRequest();
    const tool = new LoadMemoryTool();

    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.toolsDict['load_memory']).toBe(tool);
  });

  it('appends the memory instruction when no memory service is configured', async () => {
    const stub = new StubToolContext([]);
    stub.invocationContext.memoryService = undefined;
    const llmRequest = createLlmRequest();
    const tool = new LoadMemoryTool();

    await tool.processLlmRequest({
      toolContext: stub as unknown as Context,
      llmRequest,
    });

    expect(llmRequest.config?.systemInstruction).toContain('You have memory.');
    expect(llmRequest.config?.systemInstruction).toContain(
      'call load_memory function with a query',
    );
  });

  it('keeps an existing system instruction ahead of the memory instruction', async () => {
    const toolContext = new StubToolContext([]) as unknown as Context;
    const llmRequest = createLlmRequest();
    llmRequest.config = {systemInstruction: 'be terse'};
    const tool = new LoadMemoryTool();

    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.config.systemInstruction).toMatch(/^be terse/);
    expect(llmRequest.config.systemInstruction).toContain('You have memory.');
  });

  it('forwards a memory entry without touching its content', async () => {
    const entry: MemoryEntry = {
      content: {role: 'user', parts: [{text: 'a'}, {text: 'b'}]},
      author: 'user',
      timestamp: '2026-01-15T10:30:00.000Z',
    };
    const stub = new StubToolContext([entry]);
    const tool = new LoadMemoryTool();

    const result = await tool.runAsync({
      args: {query: 'hello'},
      toolContext: stub as unknown as Context,
    });

    if (!('memories' in result)) {
      expect.fail(`runAsync returned an error: ${result.error}`);
    }
    expect(result.memories).toEqual([entry]);
    expect(result.memories[0]).toBe(entry);
  });

  it('reports the missing mandatory parameter when query is absent', async () => {
    const stub = new StubToolContext([]);
    const tool = new LoadMemoryTool();

    const result = await tool.runAsync({
      args: {},
      toolContext: stub as unknown as Context,
    });

    expect(result).toEqual({error: MISSING_QUERY_ERROR});
    expect(stub.queries).toEqual([]);
  });

  it('reports the missing mandatory parameter when query is not a string', async () => {
    const stub = new StubToolContext([]);
    const tool = new LoadMemoryTool();

    const result = await tool.runAsync({
      args: {query: 42},
      toolContext: stub as unknown as Context,
    });

    expect(result).toEqual({error: MISSING_QUERY_ERROR});
    expect(stub.queries).toEqual([]);
  });

  it('passes the query through to the memory search', async () => {
    const stub = new StubToolContext([]);
    const tool = new LoadMemoryTool();

    await tool.runAsync({
      args: {query: 'favorite color'},
      toolContext: stub as unknown as Context,
    });

    expect(stub.queries).toEqual(['favorite color']);
  });
});
