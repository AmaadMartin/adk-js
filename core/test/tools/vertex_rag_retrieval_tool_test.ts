/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  FunctionTool,
  isBaseRetrievalTool,
  LlmRequest,
  VertexRagRetrievalTool,
} from '@google/adk';
import {GenerateContentConfig, Tool, Type} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn(() => ({
    getClient: async () => ({
      getRequestHeaders: async () =>
        new Headers({authorization: 'Bearer fake-token'}),
    }),
  })),
}));

const RAG_CORPUS =
  'projects/my-project/locations/us-central1/ragCorpora/my-corpus';

/** An `LlmRequest` whose `config` is guaranteed present, so tests can index it. */
type LlmRequestWithConfig = LlmRequest & {config: GenerateContentConfig};

function makeLlmRequest(model = 'gemini-2.0-flash'): LlmRequestWithConfig {
  return {
    model,
    config: {},
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  };
}

// The tool only reads `llmRequest`; the context is never touched, so an empty
// stand-in is enough.
function makeToolContext(): Context {
  return {} as Context;
}

/**
 * `config.tools` is a `ToolUnion[]` (`Tool | CallableTool`); the tool under test
 * only ever pushes plain declarative `Tool`s, so narrow to that member.
 */
function toolAt(llmRequest: LlmRequestWithConfig, index: number): Tool {
  return llmRequest.config.tools![index] as Tool;
}

/** A `retrieveContexts` reply carrying the given contexts. */
function contextsResponse(contexts: Array<{text: string}>): Response {
  return new Response(JSON.stringify({contexts: {contexts}}), {status: 200});
}

describe('VertexRagRetrievalTool', () => {
  describe('constructor', () => {
    it('names the tool vertex_rag_retrieval by default', () => {
      const tool = new VertexRagRetrievalTool({ragCorpora: [RAG_CORPUS]});

      expect(tool.name).toBe('vertex_rag_retrieval');
      expect(tool.description).toBe('Vertex AI RAG Retrieval Tool');
    });

    it('honours a supplied name and description', () => {
      const tool = new VertexRagRetrievalTool({
        name: 'rag_retrieval',
        description: 'Retrieves product documentation.',
        ragCorpora: [RAG_CORPUS],
      });

      expect(tool.name).toBe('rag_retrieval');
      expect(tool.description).toBe('Retrieves product documentation.');
    });

    it('declares the query function under the supplied name', () => {
      const tool = new VertexRagRetrievalTool({
        name: 'rag_retrieval',
        description: 'Retrieves product documentation.',
        ragCorpora: [RAG_CORPUS],
      });

      expect(tool._getDeclaration()).toEqual({
        name: 'rag_retrieval',
        description: 'Retrieves product documentation.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            query: {type: Type.STRING, description: 'The query to retrieve.'},
          },
        },
      });
    });

    it('keeps the name and the description out of the rag store', async () => {
      const tool = new VertexRagRetrievalTool({
        name: 'rag_retrieval',
        description: 'Retrieves product documentation.',
        ragCorpora: [RAG_CORPUS],
      });
      const llmRequest = makeLlmRequest();

      await tool.processLlmRequest({
        llmRequest,
        toolContext: makeToolContext(),
      });

      expect(toolAt(llmRequest, 0)).toEqual({
        retrieval: {vertexRagStore: {ragCorpora: [RAG_CORPUS]}},
      });
    });
  });

  describe('model branching', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('gives a Gemini model the built-in retrieval tool alone', async () => {
      const tool = new VertexRagRetrievalTool({
        name: 'rag_retrieval',
        description: 'rag_retrieval',
        ragCorpora: [RAG_CORPUS],
      });
      const llmRequest = makeLlmRequest('gemini-2.5-flash');

      await tool.processLlmRequest({
        llmRequest,
        toolContext: makeToolContext(),
      });

      expect(llmRequest.config.tools).toEqual([
        {retrieval: {vertexRagStore: {ragCorpora: [RAG_CORPUS]}}},
      ]);
      expect(llmRequest.toolsDict['rag_retrieval']).toBeUndefined();
    });

    it('gives a non-Gemini model the query declaration', async () => {
      const tool = new VertexRagRetrievalTool({
        name: 'rag_retrieval',
        description: 'rag_retrieval',
        ragCorpora: [RAG_CORPUS],
      });
      const llmRequest = makeLlmRequest('claude-3-sonnet');

      await tool.processLlmRequest({
        llmRequest,
        toolContext: makeToolContext(),
      });

      expect(llmRequest.config.tools).toHaveLength(1);
      expect(toolAt(llmRequest, 0).functionDeclarations?.[0].name).toBe(
        'rag_retrieval',
      );
      expect(toolAt(llmRequest, 0).retrieval).toBeUndefined();
      expect(llmRequest.toolsDict['rag_retrieval']).toBe(tool);
    });

    it('merges the declaration into an existing function tool', async () => {
      const tool = new VertexRagRetrievalTool({
        name: 'rag_retrieval',
        description: 'rag_retrieval',
        ragCorpora: [RAG_CORPUS],
      });
      const noopTool = new FunctionTool({
        name: 'noop_tool',
        description: 'Does nothing.',
        execute: async () => 'noop',
      });
      const llmRequest = makeLlmRequest('claude-3-sonnet');
      const toolContext = makeToolContext();

      await tool.processLlmRequest({llmRequest, toolContext});
      await noopTool.processLlmRequest({llmRequest, toolContext});

      const declarations = toolAt(llmRequest, 0).functionDeclarations;
      expect(declarations).toHaveLength(2);
      expect(declarations?.[0].name).toBe('rag_retrieval');
      expect(declarations?.[1].name).toBe('noop_tool');
    });

    it('takes the built-in branch when the model id check is off', async () => {
      vi.stubEnv('ADK_DISABLE_GEMINI_MODEL_ID_CHECK', 'true');
      const tool = new VertexRagRetrievalTool({
        name: 'rag_retrieval',
        description: 'rag_retrieval',
        ragCorpora: [RAG_CORPUS],
      });
      const llmRequest = makeLlmRequest('internal-model-v1');

      await tool.processLlmRequest({
        llmRequest,
        toolContext: makeToolContext(),
      });

      expect(llmRequest.config.tools).toEqual([
        {retrieval: {vertexRagStore: {ragCorpora: [RAG_CORPUS]}}},
      ]);
      expect(llmRequest.toolsDict['rag_retrieval']).toBeUndefined();
    });

    it('declares the query function when the request names no model', async () => {
      const tool = new VertexRagRetrievalTool({
        name: 'rag_retrieval',
        description: 'rag_retrieval',
        ragCorpora: [RAG_CORPUS],
      });
      const llmRequest = makeLlmRequest();
      llmRequest.model = undefined;

      await tool.processLlmRequest({
        llmRequest,
        toolContext: makeToolContext(),
      });

      expect(toolAt(llmRequest, 0).functionDeclarations?.[0].name).toBe(
        'rag_retrieval',
      );
      expect(llmRequest.toolsDict['rag_retrieval']).toBe(tool);
    });
  });

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

      expect(llmRequest.config.tools).toHaveLength(1);
      expect(llmRequest.config.tools![0]).toEqual({
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

      const vertexRagStore = toolAt(llmRequest, 0).retrieval!.vertexRagStore!;
      expect(vertexRagStore.similarityTopK).toBe(10);
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

      const vertexRagStore = toolAt(llmRequest, 0).retrieval!.vertexRagStore!;
      expect(
        vertexRagStore.ragRetrievalConfig?.filter?.vectorDistanceThreshold,
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

      const vertexRagStore = toolAt(llmRequest, 0).retrieval!.vertexRagStore!;
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
        toolsDict: {},
        liveConnectConfig: {},
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
      llmRequest.config.tools = [{googleSearch: {}}];

      await tool.processLlmRequest({
        llmRequest,
        toolContext: makeToolContext(),
      });

      expect(llmRequest.config.tools).toHaveLength(2);
      expect(toolAt(llmRequest, 1).retrieval).toBeDefined();
    });
  });

  describe('as a retrieval tool', () => {
    it('is recognised by isBaseRetrievalTool', () => {
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
      });

      expect(isBaseRetrievalTool(tool)).toBe(true);
    });

    it('keeps the inherited query declaration off the request', async () => {
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
      });
      const llmRequest = makeLlmRequest();

      await tool.processLlmRequest({
        llmRequest,
        toolContext: makeToolContext(),
      });

      expect(toolAt(llmRequest, 0).functionDeclarations).toBeUndefined();
      expect(llmRequest.toolsDict).toEqual({});
    });
  });

  // The server-side branch is the whole tool before this change, so the case
  // that asserted `runAsync()` resolves `undefined` now asserts the contract
  // that replaced it: the tool retrieves, and it needs a query to do so.
  describe('runAsync', () => {
    let fetchMock: Mock<typeof fetch>;

    beforeEach(() => {
      fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('rejects a call that carries no query', async () => {
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
      });

      await expect(
        tool.runAsync({args: {}, toolContext: makeToolContext()}),
      ).rejects.toThrow("Vertex AI RAG retrieval requires a string 'query'.");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ['a number', 42],
      ['an object', {}],
      ['null', null],
    ])('rejects %s as the query', async (_name, query) => {
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
      });

      await expect(
        tool.runAsync({args: {query}, toolContext: makeToolContext()}),
      ).rejects.toThrow("Vertex AI RAG retrieval requires a string 'query'.");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('resolves the text of every matching context, in order', async () => {
      fetchMock.mockResolvedValue(
        contextsResponse([
          {text: 'first chunk'},
          {text: 'second chunk'},
          {text: 'third chunk'},
        ]),
      );
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
      });

      const result = await tool.runAsync({
        args: {query: 'how do I ship it'},
        toolContext: makeToolContext(),
      });

      expect(result).toEqual(['first chunk', 'second chunk', 'third chunk']);
    });

    it('reports a match of nothing rather than throwing', async () => {
      fetchMock.mockResolvedValue(contextsResponse([]));
      const tool = new VertexRagRetrievalTool({
        ragResources: [{ragCorpus: RAG_CORPUS}],
        similarityTopK: 3,
      });

      const result = await tool.runAsync({
        args: {query: 'nothing matches this'},
        toolContext: makeToolContext(),
      });

      expect(result).toBe(
        'No matching result found with the config: ' +
          JSON.stringify({
            ragResources: [{ragCorpus: RAG_CORPUS}],
            similarityTopK: 3,
          }),
      );
    });

    it('sends the configured rag resources and retrieval config', async () => {
      fetchMock.mockResolvedValue(contextsResponse([{text: 'chunk'}]));
      const tool = new VertexRagRetrievalTool({
        name: 'rag_retrieval',
        description: 'rag_retrieval',
        ragCorpora: [RAG_CORPUS],
        similarityTopK: 7,
        vectorDistanceThreshold: 0.5,
      });

      await tool.runAsync({
        args: {query: 'how do I ship it'},
        toolContext: makeToolContext(),
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        'https://us-central1-aiplatform.googleapis.com/v1' +
          '/projects/my-project/locations/us-central1:retrieveContexts',
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        vertexRagStore: {ragResources: [{ragCorpus: RAG_CORPUS}]},
        query: {
          text: 'how do I ship it',
          ragRetrievalConfig: {
            topK: 7,
            filter: {vectorDistanceThreshold: 0.5},
          },
        },
      });
    });
  });
});
