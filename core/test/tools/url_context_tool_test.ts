/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InvocationContext,
  LlmRequest,
  PluginManager,
  URL_CONTEXT,
  UrlContextTool,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function makeRequest(model?: string, tools = []): LlmRequest {
  return {
    model,
    config: {tools},
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  } as unknown as LlmRequest;
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

describe('UrlContextTool', () => {
  describe('processLlmRequest', () => {
    it('returns early when model is not set', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest(undefined);
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: {} as never,
      });

      expect(req.config?.tools).toEqual([]);
    });

    it('adds urlContext for Gemini 2+ model', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('gemini-2.0-flash');
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: {} as never,
      });

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });

    it('adds urlContext for Gemini 2.5 model', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('gemini-2.5-pro');
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: {} as never,
      });

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });

    it('throws for Gemini 1.x model', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('gemini-1.5-pro');
      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: {} as never,
        }),
      ).rejects.toThrow(
        'URL context tool requires Gemini 2 or above, but got gemini-1.5-pro',
      );
    });

    it('throws for unsupported (non-Gemini) model', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('gpt-4');
      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: {} as never,
        }),
      ).rejects.toThrow('URL context tool is not supported for model gpt-4');
    });

    it('initializes config.tools when config is absent', async () => {
      const tool = new UrlContextTool();
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

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });
  });

  describe('managed agent mode', () => {
    it('configures the tool when the request names an agent, not a model', async () => {
      const req = makeRequest(undefined);
      req.isManagedAgent = true;

      await new UrlContextTool().processLlmRequest({
        llmRequest: req,
        toolContext: managedToolContext(),
      });

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });

    it('creates the tools array when the request has no config', async () => {
      const req: LlmRequest = {
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
        isManagedAgent: true,
      };

      await new UrlContextTool().processLlmRequest({
        llmRequest: req,
        toolContext: managedToolContext(),
      });

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });
  });

  it('has a global instance URL_CONTEXT', () => {
    expect(URL_CONTEXT).toBeInstanceOf(UrlContextTool);
  });
});
