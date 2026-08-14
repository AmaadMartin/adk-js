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

function makeToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'url-context-test',
      agent: new LlmAgent({name: 'url_context_test_agent'}),
      session: createSession({
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
      }),
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

    it('adds urlContext for a Gemini Live model', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('gemini-live-2.5-flash-native-audio');
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: makeToolContext(),
      });

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });

    it('throws for a Gemini 1.x Live model', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('gemini-live-1.5-flash');
      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: makeToolContext(),
        }),
      ).rejects.toThrow(
        'URL context tool requires Gemini 2 or above, but got gemini-live-1.5-flash',
      );
    });

    it('adds urlContext for an EAP model', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('gemini-flash-early-exp');
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: makeToolContext(),
      });

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });

    const extendedForms = [
      'models/gemini-2.5-pro',
      'gemini/gemini-2.5-flash',
      'apigee/vertex_ai/v1beta/gemini-2.5-flash',
      'models/gemini-flash-early-exp',
    ];

    for (const model of extendedForms) {
      it(`adds urlContext for model: ${model}`, async () => {
        const tool = new UrlContextTool();
        const req = makeRequest(model);
        await tool.processLlmRequest({
          llmRequest: req,
          toolContext: makeToolContext(),
        });

        expect(req.config!.tools).toEqual([{urlContext: {}}]);
      });
    }

    const rejectedForms: Array<[string, string]> = [
      [
        'openrouter/google/gemini-1.5-pro:online',
        'URL context tool requires Gemini 2 or above, but got openrouter/google/gemini-1.5-pro:online',
      ],
      [
        // Malformed Vertex path: the trailing segment must not be read as an
        // id, so this stays a non-Gemini model.
        'projects/123/locations/us-central1/publishers/google/gemini-2.5-flash',
        'URL context tool is not supported for model projects/123/locations/us-central1/publishers/google/gemini-2.5-flash',
      ],
    ];

    for (const [model, message] of rejectedForms) {
      it(`throws for model: ${model}`, async () => {
        const tool = new UrlContextTool();
        const req = makeRequest(model);
        await expect(
          tool.processLlmRequest({
            llmRequest: req,
            toolContext: makeToolContext(),
          }),
        ).rejects.toThrow(message);
      });
    }

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

  it('has a global instance URL_CONTEXT', () => {
    expect(URL_CONTEXT).toBeInstanceOf(UrlContextTool);
  });
});
