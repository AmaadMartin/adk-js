/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {
  Context,
  LlmRequest,
  MemoryEntry,
  PRELOAD_MEMORY,
  PreloadMemoryTool,
  SearchMemoryResponse,
} from '@google/adk';
import {Content, createModelContent, createUserContent} from '@google/genai';

// We mock the logger.warn since we test a failing case
import {vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';

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

/**
 * `Context` is a class, so a partial stub cannot satisfy it structurally. The
 * cast is confined here instead of repeated at every call site.
 */
function stubContext(memories: MemoryEntry[]): Context {
  return new StubToolContext(memories) as unknown as Context;
}

function requestWithContents(contents: Content[]): LlmRequest {
  return {contents, toolsDict: {}, liveConnectConfig: {}, config: {}};
}

function memoryEntry(text: string): MemoryEntry {
  return {content: createUserContent(text), author: 'user'};
}

describe('PreloadMemoryTool', () => {
  it('has a global instance PRELOAD_MEMORY', () => {
    expect(PRELOAD_MEMORY).toBeInstanceOf(PreloadMemoryTool);
  });

  it('throws error   in runAsync as it is not meant to be called by model', async () => {
    const tool = new PreloadMemoryTool();
    const mockContext = stubContext([]);

    await expect(
      tool.runAsync({
        args: {},
        toolContext: mockContext,
      }),
    ).rejects.toThrow('PreloadMemoryTool should not be called by model');
  });

  it('does not append instruction if userContent is empty', async () => {
    const toolContext = stubContext([]);
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
    // System instructions should NOT be appended.
    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });

  it('does not append instruction if memory service is missing', async () => {
    const toolContext = stubContext([]);
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
  });

  it('inserts formatted memory into contents if memories found', async () => {
    const toolContext = stubContext([
      {
        content: {role: 'user', parts: [{text: 'My dog is Fido.'}]},
        author: 'user',
        timestamp: '2023-01-01T12:00:00Z',
      },
      {
        content: {role: 'model', parts: [{text: 'I will remember that.'}]},
        author: 'model',
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
    expect(llmRequest.contents).toHaveLength(1);

    // Verify it contains the formatted lines
    const memoryText = llmRequest.contents[0].parts?.[0]?.text;
    expect(memoryText).toContain('Time: 2023-01-01T12:00:00Z');
    expect(memoryText).toContain('user: My dog is Fido.');
    expect(memoryText).toContain('model: I will remember that.');
    expect(memoryText).toContain('<PAST_CONVERSATIONS>');
  });

  it('handles searchMemory throwing an error gracefully', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const toolContext = stubContext([]);
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

    warnSpy.mockRestore();
  });

  it('keeps the system instruction stable and inserts before the current turn', async () => {
    const toolContext = stubContext([memoryEntry('likes tea')]);
    const llmRequest = requestWithContents([
      createUserContent('historical question'),
      createModelContent('historical answer'),
      createUserContent('current query'),
    ]);
    llmRequest.config = {systemInstruction: 'stable instruction'};

    await new PreloadMemoryTool().processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.config.systemInstruction).toBe('stable instruction');
    expect(llmRequest.contents.map((content) => content.role)).toEqual([
      'user',
      'model',
      'user',
      'user',
    ]);
    expect(llmRequest.contents.at(-2)?.parts?.[0]?.text).toContain('likes tea');
    expect(llmRequest.contents.at(-1)).toEqual(
      createUserContent('current query'),
    );
  });

  it('stays after a function response boundary', async () => {
    const functionResponse: Content = {
      role: 'user',
      parts: [{functionResponse: {name: 'lookup', response: {result: 'done'}}}],
    };
    const toolContext = stubContext([memoryEntry('likes tea')]);
    const llmRequest = requestWithContents([
      createUserContent('current query'),
      createModelContent({functionCall: {name: 'lookup', args: {}}}),
      functionResponse,
    ]);

    await new PreloadMemoryTool().processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.contents.at(-2)).toBe(functionResponse);
    expect(llmRequest.contents.at(-1)?.parts?.[0]?.text).toContain('likes tea');
  });

  it('leaves the whole request untouched when searchMemory throws', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const toolContext = stubContext([]);
    toolContext.searchMemory = async () => {
      throw new Error('unavailable');
    };
    const llmRequest = requestWithContents([
      createUserContent('current query'),
    ]);
    llmRequest.config = {systemInstruction: 'stable instruction'};
    const original = structuredClone(llmRequest);

    await new PreloadMemoryTool().processLlmRequest({toolContext, llmRequest});

    expect(llmRequest).toEqual(original);
    warnSpy.mockRestore();
  });

  it('omits the author prefix when a memory has no author', async () => {
    const toolContext = stubContext([
      {content: createUserContent('likes tea')},
    ]);
    const llmRequest = requestWithContents([]);

    await new PreloadMemoryTool().processLlmRequest({toolContext, llmRequest});

    const memoryText = llmRequest.contents[0].parts?.[0]?.text;
    expect(memoryText).toContain('\nlikes tea\n');
  });

  it('leaves contents untouched when no memories are found', async () => {
    const toolContext = stubContext([]);
    const llmRequest = requestWithContents([]);

    await new PreloadMemoryTool().processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.contents).toEqual([]);
  });

  it('leaves contents untouched when no memory carries text', async () => {
    const toolContext = stubContext([
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
    const llmRequest = requestWithContents([]);

    await new PreloadMemoryTool().processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.contents).toEqual([]);
  });
});
