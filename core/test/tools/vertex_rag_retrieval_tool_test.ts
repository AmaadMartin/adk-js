/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  VertexRagRetrievalTool,
} from '@google/adk';
import {Retrieval, VertexRagStore} from '@google/genai';
import {describe, expect, it} from 'vitest';

const RAG_CORPUS =
  'projects/my-project/locations/us-central1/ragCorpora/my-corpus';

function makeLlmRequest(model = 'gemini-2.0-flash'): LlmRequest {
  return {
    model,
    config: {},
    contents: [],
    liveConnectConfig: {},
    toolsDict: {},
  };
}

function makeToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
      }),
      pluginManager: new PluginManager([]),
    }),
  });
}

function retrievalAt(llmRequest: LlmRequest, index: number): Retrieval {
  const tool = llmRequest.config?.tools?.[index];
  if (!tool || !('retrieval' in tool) || !tool.retrieval) {
    expect.fail(`llmRequest.config.tools[${index}] has no retrieval config`);
  }
  return tool.retrieval;
}

function firstVertexRagStore(llmRequest: LlmRequest): VertexRagStore {
  const store = retrievalAt(llmRequest, 0).vertexRagStore;
  if (!store) {
    expect.fail('the first retrieval tool has no vertexRagStore');
  }
  return store;
}

describe('VertexRagRetrievalTool', () => {
  describe('processLlmRequest', () => {
    it('adds retrieval.vertexRagStore to llmRequest.config.tools', async () => {
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
      });
      const llmRequest = makeLlmRequest();

      await tool.processLlmRequest({
        llmRequest,
        toolContext: makeToolContext(),
      });

      expect(llmRequest.config?.tools).toHaveLength(1);
      expect(llmRequest.config?.tools?.[0]).toEqual({
        retrieval: {
          vertexRagStore: {
            ragResources: [{ragCorpus: RAG_CORPUS}],
          },
        },
      });
    });

    it('passes through similarityTopK when provided', async () => {
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
        similarityTopK: 10,
      });
      const llmRequest = makeLlmRequest();

      await tool.processLlmRequest({
        llmRequest,
        toolContext: makeToolContext(),
      });

      expect(firstVertexRagStore(llmRequest).similarityTopK).toBe(10);
    });

    it('passes through ragRetrievalConfig when provided', async () => {
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
        ragRetrievalConfig: {filter: {vectorDistanceThreshold: 0.5}},
      });
      const llmRequest = makeLlmRequest();

      await tool.processLlmRequest({
        llmRequest,
        toolContext: makeToolContext(),
      });

      expect(
        firstVertexRagStore(llmRequest).ragRetrievalConfig?.filter
          ?.vectorDistanceThreshold,
      ).toBe(0.5);
    });

    it('does not set optional fields when not provided', async () => {
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
      });
      const llmRequest = makeLlmRequest();

      await tool.processLlmRequest({
        llmRequest,
        toolContext: makeToolContext(),
      });

      const vertexRagStore = firstVertexRagStore(llmRequest);
      expect(vertexRagStore.similarityTopK).toBeUndefined();
      expect(vertexRagStore.ragRetrievalConfig).toBeUndefined();
    });

    it('initializes llmRequest.config and tools if not present', async () => {
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
      });
      const llmRequest: LlmRequest = {
        model: 'gemini-2.0-flash',
        contents: [],
        liveConnectConfig: {},
        toolsDict: {},
      };

      await tool.processLlmRequest({
        llmRequest,
        toolContext: makeToolContext(),
      });

      expect(llmRequest.config?.tools).toHaveLength(1);
    });

    it('appends to existing tools without removing them', async () => {
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
      });
      const llmRequest = makeLlmRequest();
      llmRequest.config = {tools: [{googleSearch: {}}]};

      await tool.processLlmRequest({
        llmRequest,
        toolContext: makeToolContext(),
      });

      expect(llmRequest.config?.tools).toHaveLength(2);
      expect(retrievalAt(llmRequest, 1).vertexRagStore).toBeDefined();
    });
  });

  describe('runAsync', () => {
    it('resolves immediately (server-side tool)', async () => {
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
      });
      const result = await tool.runAsync();
      expect(result).toBeUndefined();
    });
  });
});
