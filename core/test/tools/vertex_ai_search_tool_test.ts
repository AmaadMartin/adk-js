/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it} from 'vitest';
import {Context} from '../../src/agents/context.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {createSession} from '../../src/sessions/session.js';
import {
  BaseVertexAiSearchToolParams,
  VertexAISearchDataStoreSpec,
  VertexAiSearchTool,
  VertexAiSearchToolParams,
} from '../../src/tools/vertex_ai_search_tool.js';

/**
 * The params object the constructor destructures before it validates.
 *
 * `VertexAiSearchToolParams` marks the opposite id `?: never` in each arm, so
 * the combinations the runtime guard rejects — both ids, neither id, or
 * `dataStoreSpecs` without `searchEngineId` — cannot be spelled as a typed
 * literal, even though untyped JavaScript and config-driven callers do send
 * them.
 */
interface UnvalidatedParams extends BaseVertexAiSearchToolParams {
  dataStoreId?: string;
  searchEngineId?: string;
  dataStoreSpecs?: VertexAISearchDataStoreSpec[];
}

function newToolWithUnvalidatedParams(
  params: UnvalidatedParams,
): VertexAiSearchTool {
  return new VertexAiSearchTool(params as VertexAiSearchToolParams);
}

/**
 * Builds a real `Context` backed by a real `InvocationContext` and `Session`,
 * the way the agent request loop invokes `processLlmRequest`.
 */
function createToolContext(): Context {
  const session = createSession({id: 'test-session', appName: 'test-app'});
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test_agent', model: 'gemini-2.0-flash'}),
    session,
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext});
}

describe('VertexAiSearchTool', () => {
  it('should throw error if neither dataStoreId nor searchEngineId is specified', () => {
    expect(() => newToolWithUnvalidatedParams({})).toThrowError(
      'Either dataStoreId or searchEngineId must be specified.',
    );
  });

  it('should throw error if both dataStoreId and searchEngineId are specified', () => {
    expect(() =>
      newToolWithUnvalidatedParams({
        dataStoreId: 'ds',
        searchEngineId: 'se',
      }),
    ).toThrowError('Either dataStoreId or searchEngineId must be specified.');
  });

  it('should throw error if dataStoreSpecs is specified without searchEngineId', () => {
    expect(() =>
      newToolWithUnvalidatedParams({
        dataStoreId: 'ds',
        dataStoreSpecs: [{dataStore: 'ds1'}],
      }),
    ).toThrowError(
      'searchEngineId must be specified if dataStoreSpecs is specified.',
    );
  });

  it('should initialize correctly with dataStoreId', () => {
    const tool = new VertexAiSearchTool({dataStoreId: 'ds'});
    expect(tool.dataStoreId).toBe('ds');
    expect(tool.searchEngineId).toBeUndefined();
  });

  it('should initialize correctly with searchEngineId', () => {
    const tool = new VertexAiSearchTool({searchEngineId: 'se'});
    expect(tool.searchEngineId).toBe('se');
    expect(tool.dataStoreId).toBeUndefined();
  });

  it('should add vertexAiSearch config to llmRequest for Gemini model', async () => {
    const tool = new VertexAiSearchTool({
      dataStoreId: 'ds',
      filter: 'f',
      maxResults: 10,
    });
    const llmRequest: LlmRequest = {
      model: 'gemini-2.0-flash',
      contents: [],
      liveConnectConfig: {},
      toolsDict: {},
    };
    const toolContext = createToolContext();

    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.config?.tools).toHaveLength(1);
    const [appendedTool] = llmRequest.config?.tools ?? [];
    if (!appendedTool || !('retrieval' in appendedTool)) {
      expect.fail('Expected a retrieval tool on the LLM request.');
    }
    expect(appendedTool.retrieval?.vertexAiSearch).toEqual({
      datastore: 'ds',
      dataStoreSpecs: undefined,
      engine: undefined,
      filter: 'f',
      maxResults: 10,
    });
  });

  it('should throw error for Gemini 1.x if other tools are present and bypass is false', async () => {
    const tool = new VertexAiSearchTool({dataStoreId: 'ds'});
    const llmRequest: LlmRequest = {
      model: 'gemini-1.5-pro',
      contents: [],
      liveConnectConfig: {},
      toolsDict: {},
      config: {
        tools: [{functionDeclarations: []}],
      },
    };
    const toolContext = createToolContext();

    await expect(
      tool.processLlmRequest({toolContext, llmRequest}),
    ).rejects.toThrowError(
      'Vertex AI search tool cannot be used with other tools in Gemini 1.x.',
    );
  });

  it('should not throw error for Gemini 1.x if other tools are present and bypass is true', async () => {
    const tool = new VertexAiSearchTool({
      dataStoreId: 'ds',
      bypassMultiToolsLimit: true,
    });
    const llmRequest: LlmRequest = {
      model: 'gemini-1.5-pro',
      contents: [],
      liveConnectConfig: {},
      toolsDict: {},
      config: {
        tools: [{functionDeclarations: []}],
      },
    };
    const toolContext = createToolContext();

    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.config?.tools).toHaveLength(2);
  });

  it('should throw error for non-Gemini model', async () => {
    const tool = new VertexAiSearchTool({dataStoreId: 'ds'});
    const llmRequest: LlmRequest = {
      model: 'claude-3',
      contents: [],
      liveConnectConfig: {},
      toolsDict: {},
    };
    const toolContext = createToolContext();

    await expect(
      tool.processLlmRequest({toolContext, llmRequest}),
    ).rejects.toThrowError(
      'Vertex AI search tool is not supported for model claude-3',
    );
  });

  describe('with env override', () => {
    const originalEnv = process.env.ADK_DISABLE_GEMINI_MODEL_ID_CHECK;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.ADK_DISABLE_GEMINI_MODEL_ID_CHECK;
      } else {
        process.env.ADK_DISABLE_GEMINI_MODEL_ID_CHECK = originalEnv;
      }
    });

    it('should bypass model check if ADK_DISABLE_GEMINI_MODEL_ID_CHECK is true', async () => {
      process.env.ADK_DISABLE_GEMINI_MODEL_ID_CHECK = 'true';
      const tool = new VertexAiSearchTool({dataStoreId: 'ds'});
      const llmRequest: LlmRequest = {
        model: 'claude-3',
        contents: [],
        liveConnectConfig: {},
        toolsDict: {},
      };
      const toolContext = createToolContext();

      await tool.processLlmRequest({toolContext, llmRequest});

      expect(llmRequest.config?.tools).toHaveLength(1);
    });
  });
});
