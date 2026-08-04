/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context, LlmRequest, VertexRagRetrievalTool} from '@google/adk';
import {GenerateContentConfig, Tool, ToolUnion} from '@google/genai';
import {describe, expect, it} from 'vitest';

const RAG_CORPUS =
  'projects/my-project/locations/us-central1/ragCorpora/my-corpus';

type LlmRequestWithConfig = LlmRequest & {config: GenerateContentConfig};

function makeLlmRequest(model = 'gemini-2.0-flash'): LlmRequestWithConfig {
  return {
    model,
    config: {},
    contents: [],
    liveConnectConfig: {},
    toolsDict: {},
  };
}

const toolContext = {} as Context;

/**
 * Narrows a `ToolUnion` entry to the declarative `Tool` shape. The tool under
 * test only ever appends plain `Tool` objects, never a `CallableTool`.
 */
function asTool(tool: ToolUnion | undefined): Tool {
  if (!tool || 'callTool' in tool) {
    expect.fail('expected a declarative Tool entry');
  }
  return tool;
}

describe('VertexRagRetrievalTool', () => {
  describe('processLlmRequest', () => {
    it('adds retrieval.vertexRagStore to llmRequest.config.tools', async () => {
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
      });
      const llmRequest = makeLlmRequest();

      await tool.processLlmRequest({toolContext, llmRequest});

      expect(llmRequest.config.tools).toHaveLength(1);
      expect(asTool(llmRequest.config.tools![0])).toEqual({
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

      await tool.processLlmRequest({toolContext, llmRequest});

      const vertexRagStore = asTool(llmRequest.config.tools![0]).retrieval!
        .vertexRagStore!;
      expect(vertexRagStore.similarityTopK).toBe(10);
    });

    it('passes through ragRetrievalConfig when provided', async () => {
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
        ragRetrievalConfig: {filter: {vectorDistanceThreshold: 0.5}},
      });
      const llmRequest = makeLlmRequest();

      await tool.processLlmRequest({toolContext, llmRequest});

      const vertexRagStore = asTool(llmRequest.config.tools![0]).retrieval!
        .vertexRagStore!;
      expect(
        vertexRagStore.ragRetrievalConfig?.filter?.vectorDistanceThreshold,
      ).toBe(0.5);
    });

    it('does not set optional fields when not provided', async () => {
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
      });
      const llmRequest = makeLlmRequest();

      await tool.processLlmRequest({toolContext, llmRequest});

      const vertexRagStore = asTool(llmRequest.config.tools![0]).retrieval!
        .vertexRagStore!;
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

      await tool.processLlmRequest({toolContext, llmRequest});

      expect(llmRequest.config?.tools).toHaveLength(1);
    });

    it('appends to existing tools without removing them', async () => {
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
      });
      const llmRequest = makeLlmRequest();
      llmRequest.config.tools = [{googleSearch: {}}];

      await tool.processLlmRequest({toolContext, llmRequest});

      expect(llmRequest.config.tools).toHaveLength(2);
      expect(asTool(llmRequest.config.tools![1]).retrieval).toBeDefined();
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
