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
import {Tool} from '@google/genai';
import {describe, expect, it} from 'vitest';

function makeRequest(model?: string, tools: Tool[] = []): LlmRequest {
  return {
    model,
    config: {tools},
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  } as unknown as LlmRequest;
}

/** Builds a real `Context` backed by real ADK plumbing, with no stubs. */
function makeToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({id: 'test-session', appName: 'test-app'}),
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

    it('skips the Gemini 1.x multi-tool check when bypassMultiToolsLimit is true', async () => {
      const tool = new GoogleSearchTool({bypassMultiToolsLimit: true});
      const req = makeRequest('gemini-1.5-pro', [{functionDeclarations: []}]);
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: makeToolContext(),
      });

      expect(req.config!.tools).toEqual([
        {functionDeclarations: []},
        {googleSearchRetrieval: {}},
      ]);
    });

    it('still throws on a Gemini 1.x multi-tool request when bypassMultiToolsLimit is false', async () => {
      const tool = new GoogleSearchTool({bypassMultiToolsLimit: false});
      const req = makeRequest('gemini-1.5-pro', [{functionDeclarations: []}]);
      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: makeToolContext(),
        }),
      ).rejects.toThrow(
        'Google search tool can not be used with other tools in Gemini 1.x.',
      );
    });

    it('applies a Gemini 1.x model override to a Gemini 2+ request', async () => {
      const tool = new GoogleSearchTool({model: 'gemini-1.5-pro'});
      const req = makeRequest('gemini-2.0-flash');
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: makeToolContext(),
      });

      expect(req.config!.tools).toEqual([{googleSearchRetrieval: {}}]);
      expect(req.model).toBe('gemini-1.5-pro');
    });

    it('applies a Gemini 2+ model override to a Gemini 1.x request', async () => {
      const tool = new GoogleSearchTool({model: 'gemini-2.0-flash'});
      const req = makeRequest('gemini-1.5-pro');
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: makeToolContext(),
      });

      expect(req.config!.tools).toEqual([{googleSearch: {}}]);
      expect(req.model).toBe('gemini-2.0-flash');
    });

    it('applies the model override when the request carries no model', async () => {
      const tool = new GoogleSearchTool({model: 'gemini-2.0-flash'});
      const req = makeRequest(undefined);
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: makeToolContext(),
      });

      expect(req.config!.tools).toEqual([{googleSearch: {}}]);
      expect(req.model).toBe('gemini-2.0-flash');
    });

    it('leaves the request model untouched when no override is set', async () => {
      const tool = new GoogleSearchTool();
      const req = makeRequest('gemini-2.0-flash');
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: makeToolContext(),
      });

      expect(req.model).toBe('gemini-2.0-flash');
      expect(req.config!.tools).toEqual([{googleSearch: {}}]);
    });

    it('leaves Gemini 2+ behaviour unchanged when bypassMultiToolsLimit is true', async () => {
      const tool = new GoogleSearchTool({bypassMultiToolsLimit: true});
      const req = makeRequest('gemini-2.0-flash', [{functionDeclarations: []}]);
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: makeToolContext(),
      });

      expect(req.config!.tools).toEqual([
        {functionDeclarations: []},
        {googleSearch: {}},
      ]);
    });
  });

  it('has a global instance GOOGLE_SEARCH', () => {
    expect(GOOGLE_SEARCH).toBeInstanceOf(GoogleSearchTool);
  });

  it('defaults to no bypass and no model override', () => {
    const tool = new GoogleSearchTool();

    expect(tool.bypassMultiToolsLimit).toBe(false);
    expect(tool.model).toBeUndefined();
    expect(GOOGLE_SEARCH.bypassMultiToolsLimit).toBe(false);
    expect(GOOGLE_SEARCH.model).toBeUndefined();
  });
});
