/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  GOOGLE_SEARCH,
  GoogleSearchTool,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
} from '@google/adk';
import {GenerateContentConfig} from '@google/genai';
import {describe, expect, it} from 'vitest';

function makeRequest(
  model?: string,
  tools: GenerateContentConfig['tools'] = [],
): LlmRequest {
  return {
    model,
    config: {tools},
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  } as unknown as LlmRequest;
}

function makeToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'google-search-test',
      agent: new LlmAgent({name: 'google_search_test_agent'}),
      session: createSession({
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
      }),
      pluginManager: new PluginManager([]),
    }),
  });
}

describe('GoogleSearchTool', () => {
  describe('processLlmRequest', () => {
    it('returns early when model is not set', async () => {
      const tool = new GoogleSearchTool();
      const req = makeRequest(undefined);
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: {} as never,
      });

      expect(req.config?.tools).toEqual([]);
    });

    it('adds googleSearchRetrieval for Gemini 1.x model', async () => {
      const tool = new GoogleSearchTool();
      const req = makeRequest('gemini-1.5-pro');
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: {} as never,
      });

      expect(req.config!.tools).toEqual([{googleSearchRetrieval: {}}]);
    });

    it('throws when Gemini 1.x model already has other tools', async () => {
      const tool = new GoogleSearchTool();
      const req = makeRequest('gemini-1.5-pro', [{functionDeclarations: []}]);
      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: {} as never,
        }),
      ).rejects.toThrow(
        'Google search tool can not be used with other tools in Gemini 1.x.',
      );
    });

    it('adds googleSearch for Gemini 2+ model', async () => {
      const tool = new GoogleSearchTool();
      const req = makeRequest('gemini-2.0-flash');
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: {} as never,
      });

      expect(req.config!.tools).toEqual([{googleSearch: {}}]);
    });

    const undottedGemini1Ids = ['gemini-1', 'gemini-1-pro', 'gemini-10.0-pro'];

    for (const model of undottedGemini1Ids) {
      it(`adds googleSearch, not googleSearchRetrieval, for model: ${model}`, async () => {
        const tool = new GoogleSearchTool();
        const req = makeRequest(model);
        await tool.processLlmRequest({
          llmRequest: req,
          toolContext: makeToolContext(),
        });

        expect(req.config!.tools).toEqual([{googleSearch: {}}]);
      });

      it(`does not reject other tools alongside model: ${model}`, async () => {
        const tool = new GoogleSearchTool();
        const req = makeRequest(model, [{functionDeclarations: []}]);
        await tool.processLlmRequest({
          llmRequest: req,
          toolContext: makeToolContext(),
        });

        expect(req.config!.tools).toEqual([
          {functionDeclarations: []},
          {googleSearch: {}},
        ]);
      });
    }

    it('throws for unsupported (non-Gemini) model', async () => {
      const tool = new GoogleSearchTool();
      const req = makeRequest('gpt-4');
      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: {} as never,
        }),
      ).rejects.toThrow('Google search tool is not supported for model gpt-4');
    });

    it('initializes config.tools when config is absent', async () => {
      const tool = new GoogleSearchTool();
      const req: LlmRequest = {
        model: 'gemini-2.0-flash',
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
      } as unknown as LlmRequest;
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: {} as never,
      });

      expect(req.config!.tools).toEqual([{googleSearch: {}}]);
    });
  });

  it('has a global instance GOOGLE_SEARCH', () => {
    expect(GOOGLE_SEARCH).toBeInstanceOf(GoogleSearchTool);
  });
});
