/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {
  BaseMemoryService,
  Context,
  createEvent,
  createSession,
  InMemoryMemoryService,
  LlmRequest,
  MemoryEntry,
  PRELOAD_MEMORY,
  PreloadMemoryTool,
  SearchMemoryResponse,
} from '@google/adk';
import {Content} from '@google/genai';

// We mock the logger.warn since we test a failing case
import {vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';
import {createMemoryToolContext} from './test_helpers.js';

class StubToolContext {
  private memories: MemoryEntry[];

  constructor(memories: MemoryEntry[]) {
    this.memories = memories;
  }

  // Stub property needed to supply userContent
  userContent = {
    role: 'user',
    parts: [{text: 'hello'}],
  };

  invocationContext = {
    // Just needs to exist
    memoryService: {},
  };

  async searchMemory(_query: string): Promise<SearchMemoryResponse> {
    return {memories: this.memories};
  }
}

function userTurn(text: string): Content {
  return {role: 'user', parts: [{text}]};
}

function modelTurn(text: string): Content {
  return {role: 'model', parts: [{text}]};
}

function memoryOf(text: string): MemoryEntry {
  return {
    content: userTurn(text),
    author: 'user',
    timestamp: '2026-07-13T12:00:00Z',
  };
}

describe('PreloadMemoryTool', () => {
  it('has a global instance PRELOAD_MEMORY', () => {
    expect(PRELOAD_MEMORY).toBeInstanceOf(PreloadMemoryTool);
  });

  it('throws error   in runAsync as it is not meant to be called by model', async () => {
    const tool = new PreloadMemoryTool();
    const mockContext = new StubToolContext([]) as unknown as Context;

    await expect(
      tool.runAsync({
        args: {},
        toolContext: mockContext,
      }),
    ).rejects.toThrow('PreloadMemoryTool should not be called by model');
  });

  it('does not append instruction if userContent is empty', async () => {
    const toolContext = new StubToolContext([]) as unknown as Context;
    // empty content, get around read-only with a trip to types unknown
    (toolContext as unknown as {userContent: unknown}).userContent = undefined;

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {},
    };
    const tool = new PreloadMemoryTool();
    await tool.processLlmRequest({toolContext, llmRequest});
    // Nothing is recalled, so neither the prefix nor the contents move.
    expect(llmRequest.config?.systemInstruction).toBeUndefined();
    expect(llmRequest.contents).toEqual([]);
  });

  it('does not append instruction if memory service is missing', async () => {
    const toolContext = new StubToolContext([]) as unknown as Context;
    (toolContext.invocationContext as {memoryService?: unknown}).memoryService =
      undefined;

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {},
    };
    const tool = new PreloadMemoryTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
    expect(llmRequest.contents).toEqual([]);
  });

  it('inserts a user content with formatted memory if memories found', async () => {
    const toolContext = new StubToolContext([
      {
        content: {role: 'user', parts: [{text: 'My dog is Fido.'}]},
        author: 'user',
        timestamp: '2023-01-01T12:00:00Z',
      },
      {
        content: {role: 'model', parts: [{text: 'I will remember that.'}]},
        author: 'model',
      },
    ]) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {},
    };
    const tool = new PreloadMemoryTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
    const inserted = llmRequest.contents[0];
    expect(inserted?.role).toBe('user');

    // Verify it contains the formatted lines
    const text = inserted?.parts?.[0]?.text;
    expect(text).toContain('Time: 2023-01-01T12:00:00Z');
    expect(text).toContain('user: My dog is Fido.');
    expect(text).toContain('model: I will remember that.');
    expect(text).toContain('<PAST_CONVERSATIONS>');
  });

  it('does not append instruction if every memory is text-free and untimestamped', async () => {
    const toolContext = createMemoryToolContext([
      {
        content: {
          role: 'user',
          parts: [
            {functionCall: {name: 'f'}},
            {inlineData: {mimeType: 'audio/wav', data: 'AAAA'}},
          ],
        },
        author: 'user',
      },
    ]);

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {},
    };
    const tool = new PreloadMemoryTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
    expect(llmRequest.contents).toEqual([]);
  });

  it('joins mixed text and text-free parts with a single space', async () => {
    const toolContext = createMemoryToolContext([
      {
        content: {
          role: 'user',
          parts: [
            {text: 'hello'},
            {functionCall: {name: 'f'}},
            {text: 'world'},
          ],
        },
        author: 'user',
      },
    ]);

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {},
    };
    const tool = new PreloadMemoryTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.contents[0]?.parts?.[0]?.text).toContain(
      '<PAST_CONVERSATIONS>\nuser: hello world\n</PAST_CONVERSATIONS>',
    );
  });

  it('keeps a session recorded through InMemoryMemoryService at one space', async () => {
    const memoryService = new InMemoryMemoryService();
    const session = createSession({
      id: 'past-session',
      appName: 'test-app',
      userId: 'test-user',
      events: [
        createEvent({
          author: 'user',
          content: {
            role: 'user',
            parts: [
              {text: 'hello'},
              {functionCall: {name: 'f'}},
              {text: 'world'},
            ],
          },
        }),
      ],
    });
    await memoryService.addSessionToMemory(session);
    const toolContext = createMemoryToolContext([], memoryService);

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {},
    };
    const tool = new PreloadMemoryTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.contents[0]?.parts?.[0]?.text).toContain(
      'user: hello world',
    );
  });

  it('handles searchMemory throwing an error gracefully', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const toolContext = new StubToolContext([]) as unknown as Context;
    toolContext.searchMemory = async () => {
      throw new Error('Search failed');
    };

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {},
    };
    const tool = new PreloadMemoryTool();

    await expect(
      tool.processLlmRequest({toolContext, llmRequest}),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to preload memory for query: hello',
    );
    expect(llmRequest.config?.systemInstruction).toBeUndefined();
    expect(llmRequest.contents).toEqual([]);

    warnSpy.mockRestore();
  });

  it('keeps the system instruction prefix stable', async () => {
    const currentQuery = userTurn('current query');
    const llmRequest: LlmRequest = {
      contents: [
        userTurn('historical question'),
        modelTurn('historical answer'),
        currentQuery,
      ],
      toolsDict: {},
      liveConnectConfig: {},
      config: {systemInstruction: 'stable instruction'},
    };

    await new PreloadMemoryTool().processLlmRequest({
      toolContext: createMemoryToolContext([memoryOf('likes tea')]),
      llmRequest,
    });

    expect(llmRequest.config?.systemInstruction).toBe('stable instruction');
    expect(llmRequest.contents.map((content) => content.role)).toEqual([
      'user',
      'model',
      'user',
      'user',
    ]);
    expect(llmRequest.contents[2]?.parts?.[0]?.text).toContain('likes tea');
    expect(llmRequest.contents[3]).toBe(currentQuery);
  });

  it('stays after a trailing function response', async () => {
    const response: Content = {
      role: 'user',
      parts: [{functionResponse: {name: 'lookup', response: {result: 'done'}}}],
    };
    const llmRequest: LlmRequest = {
      contents: [
        userTurn('current query'),
        {role: 'model', parts: [{functionCall: {name: 'lookup', args: {}}}]},
        response,
      ],
      toolsDict: {},
      liveConnectConfig: {},
      config: {},
    };

    await new PreloadMemoryTool().processLlmRequest({
      toolContext: createMemoryToolContext([memoryOf('likes tea')]),
      llmRequest,
    });

    expect(llmRequest.contents).toHaveLength(4);
    expect(llmRequest.contents[2]).toBe(response);
    expect(llmRequest.contents[3]?.parts?.[0]?.text).toContain('likes tea');
  });

  it('keeps a stable prefix across different recalled memories', async () => {
    const requests: LlmRequest[] = [];
    for (const memoryText of ['likes tea', 'likes coffee']) {
      const llmRequest: LlmRequest = {
        contents: [
          userTurn('historical question'),
          modelTurn('historical answer'),
          userTurn('current query'),
        ],
        toolsDict: {},
        liveConnectConfig: {},
        config: {systemInstruction: 'stable instruction'},
      };
      await new PreloadMemoryTool().processLlmRequest({
        toolContext: createMemoryToolContext([memoryOf(memoryText)]),
        llmRequest,
      });
      requests.push(llmRequest);
    }

    const [tea, coffee] = requests;
    expect(tea?.config?.systemInstruction).toBe(
      coffee?.config?.systemInstruction,
    );
    expect(tea?.contents.slice(0, 2)).toEqual(coffee?.contents.slice(0, 2));
    expect(tea?.contents[2]).not.toEqual(coffee?.contents[2]);
    expect(tea?.contents[3]).toEqual(coffee?.contents[3]);
  });

  it('leaves the request untouched when the search fails', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const failingMemoryService: BaseMemoryService = {
      async addSessionToMemory(): Promise<void> {},
      async searchMemory(): Promise<SearchMemoryResponse> {
        throw new Error('unavailable');
      },
    };
    const llmRequest: LlmRequest = {
      contents: [userTurn('current query')],
      toolsDict: {},
      liveConnectConfig: {},
      config: {systemInstruction: 'stable instruction'},
    };
    const before = structuredClone(llmRequest.contents);

    await new PreloadMemoryTool().processLlmRequest({
      toolContext: createMemoryToolContext([], failingMemoryService),
      llmRequest,
    });

    expect(llmRequest.contents).toEqual(before);
    expect(llmRequest.config?.systemInstruction).toBe('stable instruction');
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to preload memory for query: hello',
    );

    warnSpy.mockRestore();
  });

  it('inserts nothing when the search returns no memories', async () => {
    const llmRequest: LlmRequest = {
      contents: [userTurn('current query')],
      toolsDict: {},
      liveConnectConfig: {},
      config: {},
    };

    await new PreloadMemoryTool().processLlmRequest({
      toolContext: createMemoryToolContext([]),
      llmRequest,
    });

    expect(llmRequest.contents).toHaveLength(1);
    expect(llmRequest.contents[0]?.parts?.[0]?.text).toBe('current query');
  });

  it('inserts nothing when every memory has no text', async () => {
    const llmRequest: LlmRequest = {
      contents: [userTurn('current query')],
      toolsDict: {},
      liveConnectConfig: {},
      config: {},
    };

    await new PreloadMemoryTool().processLlmRequest({
      toolContext: createMemoryToolContext([
        {
          content: {role: 'user', parts: [{functionCall: {name: 'f'}}]},
          author: 'user',
        },
      ]),
      llmRequest,
    });

    expect(llmRequest.contents).toHaveLength(1);
    expect(llmRequest.contents[0]?.parts?.[0]?.text).toBe('current query');
  });
});
