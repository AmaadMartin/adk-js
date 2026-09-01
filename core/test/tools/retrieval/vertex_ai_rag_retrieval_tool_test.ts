/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  FunctionTool,
  LlmRequest,
  VertexAiRagRetrievalTool,
} from '@google/adk';
import {GenerateContentConfig, Tool} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

const RAG_CORPUS =
  'projects/123456789/locations/us-central1/ragCorpora/1234567890';
const TOOL_NAME = 'rag_retrieval';

/** An `LlmRequest` whose `config` is guaranteed present, so tests can index it. */
type LlmRequestWithConfig = LlmRequest & {config: GenerateContentConfig};

function makeTool(): VertexAiRagRetrievalTool {
  return new VertexAiRagRetrievalTool({
    name: TOOL_NAME,
    description: TOOL_NAME,
    ragCorpora: [RAG_CORPUS],
  });
}

function makeLlmRequest(model: string): LlmRequestWithConfig {
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

describe('VertexAiRagRetrievalTool', () => {
  describe('processLlmRequest', () => {
    it('declares a callable function for a Gemini 1.x model', async () => {
      const tool = makeTool();
      const llmRequest = makeLlmRequest('gemini-1.5-pro');

      await tool.processLlmRequest({
        llmRequest,
        toolContext: makeToolContext(),
      });

      expect(llmRequest.config.tools).toHaveLength(1);
      expect(toolAt(llmRequest, 0).functionDeclarations![0].name).toBe(
        TOOL_NAME,
      );
      expect(llmRequest.toolsDict[TOOL_NAME]).toBe(tool);
    });

    it("merges its declaration with another function tool's", async () => {
      const tool = makeTool();
      const noopTool = new FunctionTool({
        name: 'noop_tool',
        description: 'Returns its input.',
        parameters: z.object({x: z.string()}),
        execute: async ({x}) => x,
      });
      const llmRequest = makeLlmRequest('gemini-1.5-pro');

      await tool.processLlmRequest({
        llmRequest,
        toolContext: makeToolContext(),
      });
      await noopTool.processLlmRequest({
        llmRequest,
        toolContext: makeToolContext(),
      });

      const declarations = toolAt(llmRequest, 0).functionDeclarations!;
      expect(declarations).toHaveLength(2);
      expect(declarations[0].name).toBe(TOOL_NAME);
      expect(declarations[1].name).toBe('noop_tool');
      expect(llmRequest.toolsDict[TOOL_NAME]).toBe(tool);
    });

    it('configures the model-side RAG store for a Gemini 2.x model', async () => {
      const tool = makeTool();
      const llmRequest = makeLlmRequest('gemini-2.0-flash');

      await tool.processLlmRequest({
        llmRequest,
        toolContext: makeToolContext(),
      });

      expect(llmRequest.config.tools).toEqual([
        {retrieval: {vertexRagStore: {ragCorpora: [RAG_CORPUS]}}},
      ]);
      // `toolsDict` is a plain object, so a bare lookup walks
      // `Object.prototype`; ask for an own property instead.
      expect(Object.hasOwn(llmRequest.toolsDict, TOOL_NAME)).toBe(false);
    });

    // An adk-js routing case, not one of the three translated v0.2.0 cases.
    // adk-python's default branch pins the same behaviour in
    // `test_vertex_rag_retrieval_for_non_gemini`.
    it('declares a callable function for a non-Gemini model', async () => {
      const tool = makeTool();
      const llmRequest = makeLlmRequest('claude-3-sonnet');

      await tool.processLlmRequest({
        llmRequest,
        toolContext: makeToolContext(),
      });

      expect(llmRequest.config.tools).toHaveLength(1);
      expect(toolAt(llmRequest, 0).functionDeclarations![0].name).toBe(
        TOOL_NAME,
      );
      expect(llmRequest.toolsDict[TOOL_NAME]).toBe(tool);
    });
  });
});
