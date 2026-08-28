/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {
  BaseMemoryService,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LOAD_MEMORY,
  LoadMemoryTool,
  MemoryEntry,
  PluginManager,
  SearchMemoryRequest,
  SearchMemoryResponse,
  Session,
} from '@google/adk';

const MISSING_QUERY_ERROR =
  'Invoking `load_memory()` failed as the following mandatory input parameters are not present:\n' +
  'query\n' +
  'You could retry calling this tool, but it is IMPORTANT for you to provide all the mandatory parameters.';

/** A memory service that returns fixed entries and records what it was asked. */
class RecordingMemoryService implements BaseMemoryService {
  /** Every query the tool searched for, in call order. */
  readonly queries: string[] = [];

  constructor(private readonly memories: MemoryEntry[]) {}

  async addSessionToMemory(_session: Session): Promise<void> {}

  async searchMemory(
    request: SearchMemoryRequest,
  ): Promise<SearchMemoryResponse> {
    this.queries.push(request.query);
    return {memories: this.memories};
  }
}

/**
 * Builds a real tool context, so the tool reaches memory the way it does in
 * production. Pass no service to model an agent that lists the tool without
 * configuring memory.
 */
function createToolContext(memoryService?: BaseMemoryService): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: 'memory_agent'}),
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager([]),
      memoryService,
    }),
  });
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
    const toolContext = createToolContext(
      new RecordingMemoryService([
        {
          content: {role: 'user', parts: [{text: 'hi'}]},
          author: 'someone',
        },
      ]),
    );

    const result = await tool.runAsync({
      args: {query: 'hello'},
      toolContext,
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
    const toolContext = createToolContext();

    await expect(
      tool.runAsync({
        args: {query: 'hello'},
        toolContext,
      }),
    ).rejects.toThrow('Memory service is not initialized.');
  });

  it('appends system instructions if memoryService is present in context', async () => {
    const toolContext = createToolContext(new RecordingMemoryService([]));

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

  it('registers itself in the request tools so the model can call it', async () => {
    const toolContext = createToolContext(new RecordingMemoryService([]));
    const llmRequest = createLlmRequest();
    const tool = new LoadMemoryTool();

    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.toolsDict['load_memory']).toBe(tool);
  });

  it('appends the memory instruction when no memory service is configured', async () => {
    const toolContext = createToolContext();
    const llmRequest = createLlmRequest();
    const tool = new LoadMemoryTool();

    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.config?.systemInstruction).toEqual(
      expect.stringContaining('You have memory.'),
    );
    expect(llmRequest.config?.systemInstruction).toEqual(
      expect.stringContaining('call load_memory function with a query'),
    );
  });

  it('keeps an existing system instruction ahead of the memory instruction', async () => {
    const toolContext = createToolContext(new RecordingMemoryService([]));
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
    const toolContext = createToolContext(new RecordingMemoryService([entry]));
    const tool = new LoadMemoryTool();

    const result = await tool.runAsync({
      args: {query: 'hello'},
      toolContext,
    });

    if (!('memories' in result)) {
      expect.fail(`runAsync returned an error: ${result.error}`);
    }
    expect(result.memories).toEqual([entry]);
    expect(result.memories[0]).toBe(entry);
  });

  it('reports the missing mandatory parameter when query is absent', async () => {
    const memoryService = new RecordingMemoryService([]);
    const tool = new LoadMemoryTool();

    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext(memoryService),
    });

    expect(result).toEqual({error: MISSING_QUERY_ERROR});
    expect(memoryService.queries).toEqual([]);
  });

  it('reports the missing mandatory parameter when query is not a string', async () => {
    const memoryService = new RecordingMemoryService([]);
    const tool = new LoadMemoryTool();

    const result = await tool.runAsync({
      args: {query: 42},
      toolContext: createToolContext(memoryService),
    });

    expect(result).toEqual({error: MISSING_QUERY_ERROR});
    expect(memoryService.queries).toEqual([]);
  });

  it('passes the query through to the memory search', async () => {
    const memoryService = new RecordingMemoryService([]);
    const tool = new LoadMemoryTool();

    await tool.runAsync({
      args: {query: 'favorite color'},
      toolContext: createToolContext(memoryService),
    });

    expect(memoryService.queries).toEqual(['favorite color']);
  });
});
