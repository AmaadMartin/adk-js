/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context, LlmRequest, VertexRagRetrievalTool} from '@google/adk';
import {VertexRagStore} from '@google/genai';
import {describe, expect, it} from 'vitest';

const RAG_CORPUS =
  'projects/my-project/locations/us-central1/ragCorpora/my-corpus';

const toolContext = {} as Context;

function makeLlmRequest(model = 'gemini-2.0-flash'): LlmRequest {
  return {
    model,
    config: {},
    contents: [],
    liveConnectConfig: {},
    toolsDict: {},
  };
}

/** Returns the `vertexRagStore` of the retrieval tool at `index`. */
function vertexRagStoreOf(llmRequest: LlmRequest, index = 0): VertexRagStore {
  const tool = llmRequest.config?.tools?.[index];
  const vertexRagStore =
    tool && 'retrieval' in tool ? tool.retrieval?.vertexRagStore : undefined;
  if (!vertexRagStore) {
    expect.fail(
      `expected a vertexRagStore retrieval tool at index ${index}, got ${JSON.stringify(llmRequest.config?.tools)}`,
    );
  }
  return vertexRagStore;
}

describe('VertexRagRetrievalTool', () => {
  describe('processLlmRequest', () => {
    it('adds retrieval.vertexRagStore to llmRequest.config.tools', async () => {
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
      });
      const llmRequest = makeLlmRequest();

      await tool.processLlmRequest({llmRequest, toolContext});

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

      await tool.processLlmRequest({llmRequest, toolContext});

      expect(vertexRagStoreOf(llmRequest).similarityTopK).toBe(10);
    });

    it('passes through ragRetrievalConfig when provided', async () => {
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
        ragRetrievalConfig: {filter: {vectorDistanceThreshold: 0.5}},
      });
      const llmRequest = makeLlmRequest();

      await tool.processLlmRequest({llmRequest, toolContext});

      expect(
        vertexRagStoreOf(llmRequest).ragRetrievalConfig?.filter
          ?.vectorDistanceThreshold,
      ).toBe(0.5);
    });

    it('does not set optional fields when not provided', async () => {
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
      });
      const llmRequest = makeLlmRequest();

      await tool.processLlmRequest({llmRequest, toolContext});

      const vertexRagStore = vertexRagStoreOf(llmRequest);
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

      await tool.processLlmRequest({llmRequest, toolContext});

      expect(llmRequest.config?.tools).toHaveLength(1);
    });

    it('appends to existing tools without removing them', async () => {
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
      });
      const llmRequest = makeLlmRequest();
      llmRequest.config = {tools: [{googleSearch: {}}]};

      await tool.processLlmRequest({llmRequest, toolContext});

      expect(llmRequest.config?.tools).toHaveLength(2);
      expect(vertexRagStoreOf(llmRequest, 1).ragResources).toEqual([
        {ragCorpus: RAG_CORPUS},
      ]);
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
