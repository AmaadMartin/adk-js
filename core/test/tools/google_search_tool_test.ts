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
  };
}

/**
 * A real {@link Context}, so the managed-agent tests do not have to cast one.
 * The tool reads nothing off it, but the signature requires it.
 */
function managedToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv1',
      session: createSession({id: 's1', appName: 'test', userId: 'user'}),
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
      };
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: {} as never,
      });

      expect(req.config!.tools).toEqual([{googleSearch: {}}]);
    });
  });

  describe('managed agent mode', () => {
    it('configures the tool when the request names an agent, not a model', async () => {
      const req = makeRequest(undefined);
      req.isManagedAgent = true;

      await new GoogleSearchTool().processLlmRequest({
        llmRequest: req,
        toolContext: managedToolContext(),
      });

      expect(req.config!.tools).toEqual([{googleSearch: {}}]);
    });

    it('creates the tools array when the request has no config', async () => {
      const req: LlmRequest = {
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
        isManagedAgent: true,
      };

      await new GoogleSearchTool().processLlmRequest({
        llmRequest: req,
        toolContext: managedToolContext(),
      });

      expect(req.config!.tools).toEqual([{googleSearch: {}}]);
    });
  });

  it('has a global instance GOOGLE_SEARCH', () => {
    expect(GOOGLE_SEARCH).toBeInstanceOf(GoogleSearchTool);
  });
});
