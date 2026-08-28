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
import {afterEach, describe, expect, it, vi} from 'vitest';

const MODEL_ID_CHECK_ENV_VAR = 'ADK_DISABLE_GEMINI_MODEL_ID_CHECK';

function makeRequest(model?: string, tools: Tool[] = []): LlmRequest {
  return {
    model,
    config: {tools},
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  };
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
    it('throws when model is not set', async () => {
      const tool = new GoogleSearchTool();
      const req = makeRequest(undefined);

      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: makeToolContext(),
        }),
      ).rejects.toThrow(
        'Google search tool is not supported for model undefined',
      );

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

    describe('ADK_DISABLE_GEMINI_MODEL_ID_CHECK', () => {
      afterEach(() => {
        vi.unstubAllEnvs();
      });

      it('adds googleSearch for a non-Gemini model when the check is disabled', async () => {
        vi.stubEnv(MODEL_ID_CHECK_ENV_VAR, 'true');
        const tool = new GoogleSearchTool();
        const req = makeRequest('internal-model-v1');

        await tool.processLlmRequest({
          llmRequest: req,
          toolContext: makeToolContext(),
        });

        expect(req.config!.tools).toEqual([{googleSearch: {}}]);
      });

      it('keeps Gemini 1.x handling when the check is disabled', async () => {
        vi.stubEnv(MODEL_ID_CHECK_ENV_VAR, 'true');
        const tool = new GoogleSearchTool();
        const req = makeRequest('gemini-1.5-pro');

        await tool.processLlmRequest({
          llmRequest: req,
          toolContext: makeToolContext(),
        });

        expect(req.config!.tools).toEqual([{googleSearchRetrieval: {}}]);
      });

      it('still throws for a non-Gemini model when the value is falsy', async () => {
        vi.stubEnv(MODEL_ID_CHECK_ENV_VAR, 'false');
        const tool = new GoogleSearchTool();
        const req = makeRequest('internal-model-v1');

        await expect(
          tool.processLlmRequest({
            llmRequest: req,
            toolContext: makeToolContext(),
          }),
        ).rejects.toThrow(
          'Google search tool is not supported for model internal-model-v1',
        );
      });
    });

    it.each(['gemini-2.0-pro', 'gemini-2.5-flash', 'gemini-2.5-pro'])(
      'adds googleSearch for %s',
      async (model) => {
        const tool = new GoogleSearchTool();
        const req = makeRequest(model);

        await tool.processLlmRequest({
          llmRequest: req,
          toolContext: makeToolContext(),
        });

        expect(req.config!.tools).toEqual([{googleSearch: {}}]);
      },
    );

    it('adds googleSearch for a path-based Gemini model', async () => {
      const tool = new GoogleSearchTool();
      const req = makeRequest(
        'projects/265104255505/locations/us-central1/publishers/google/models/gemini-2.5-flash',
      );

      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: makeToolContext(),
      });

      expect(req.config!.tools).toEqual([{googleSearch: {}}]);
    });

    it('appends googleSearch after the tools already on the request', async () => {
      const tool = new GoogleSearchTool();
      const existingTool: Tool = {functionDeclarations: [{name: 'get_time'}]};
      const req = makeRequest('gemini-2.5-flash', [existingTool]);

      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: makeToolContext(),
      });

      expect(req.config!.tools).toEqual([existingTool, {googleSearch: {}}]);
    });

    it('initializes config.tools when the config has no tools', async () => {
      const tool = new GoogleSearchTool();
      const req: LlmRequest = {
        model: 'gemini-2.5-flash',
        config: {},
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
      };

      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: makeToolContext(),
      });

      expect(req.config!.tools).toEqual([{googleSearch: {}}]);
    });

    it('throws for a path-based non-Gemini model', async () => {
      const tool = new GoogleSearchTool();
      const req = makeRequest(
        'projects/265104255505/locations/us-central1/publishers/google/models/claude-3-sonnet',
      );

      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: makeToolContext(),
        }),
      ).rejects.toThrow(
        'Google search tool is not supported for model projects/265104255505/locations/us-central1/publishers/google/models/claude-3-sonnet',
      );
    });

    it('throws when the model is an empty string', async () => {
      const tool = new GoogleSearchTool();
      const req = makeRequest('');

      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: makeToolContext(),
        }),
      ).rejects.toThrow('Google search tool is not supported for model');

      expect(req.config!.tools).toEqual([]);
    });

    it.each([
      'my-gemini-1.5-model',
      'custom-gemini-2.5-flash',
      'projects/265104255505/locations/us-central1/publishers/gemini/models/claude-3-sonnet',
    ])('throws for the near-miss model id %s', async (model) => {
      const tool = new GoogleSearchTool();
      const req = makeRequest(model);

      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: makeToolContext(),
        }),
      ).rejects.toThrow('Google search tool is not supported for model');

      expect(req.config!.tools).toEqual([]);
    });

    it('replaces the request model with the model option', async () => {
      const tool = new GoogleSearchTool({model: 'gemini-2.5-flash-lite'});
      const req = makeRequest('gemini-2.5-flash');

      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: makeToolContext(),
      });

      expect(req.model).toBe('gemini-2.5-flash-lite');
      expect(req.config!.tools).toEqual([{googleSearch: {}}]);
    });

    it('keeps the request model when no model option is set', async () => {
      const tool = new GoogleSearchTool();
      const req = makeRequest('gemini-2.5-flash');

      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: makeToolContext(),
      });

      expect(req.model).toBe('gemini-2.5-flash');
      expect(req.config!.tools).toEqual([{googleSearch: {}}]);
    });

    it('validates the model option rather than the request model', async () => {
      const tool = new GoogleSearchTool({model: 'gemini-2.5-flash'});
      const req = makeRequest('claude-3-sonnet');

      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: makeToolContext(),
      });

      expect(req.model).toBe('gemini-2.5-flash');
      expect(req.config!.tools).toEqual([{googleSearch: {}}]);
    });

    it('applies an empty model option and then rejects it', async () => {
      const tool = new GoogleSearchTool({model: ''});
      const req = makeRequest('gemini-2.5-flash');

      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: makeToolContext(),
        }),
      ).rejects.toThrow('Google search tool is not supported for model');

      expect(req.model).toBe('');
      expect(req.config!.tools).toEqual([]);
    });

    it('adds googleSearchRetrieval beside other tools when the bypass is set', async () => {
      const tool = new GoogleSearchTool({bypassMultiToolsLimit: true});
      const existingTool: Tool = {functionDeclarations: [{name: 'get_time'}]};
      const req = makeRequest('gemini-1.5-pro', [existingTool]);

      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: makeToolContext(),
      });

      expect(req.config!.tools).toEqual([
        existingTool,
        {googleSearchRetrieval: {}},
      ]);
    });
  });

  it('exposes the constructor defaults', () => {
    const tool = new GoogleSearchTool();

    expect(tool.name).toBe('google_search');
    expect(tool.bypassMultiToolsLimit).toBe(false);
    expect(tool.model).toBeUndefined();
  });

  it('exposes the constructor options', () => {
    const tool = new GoogleSearchTool({
      bypassMultiToolsLimit: true,
      model: 'gemini-2.5-flash-lite',
    });

    expect(tool.bypassMultiToolsLimit).toBe(true);
    expect(tool.model).toBe('gemini-2.5-flash-lite');
  });

  it('resolves runAsync', async () => {
    await expect(new GoogleSearchTool().runAsync()).resolves.toBeUndefined();
  });

  it('has a global instance GOOGLE_SEARCH', () => {
    expect(GOOGLE_SEARCH).toBeInstanceOf(GoogleSearchTool);
  });

  it('builds GOOGLE_SEARCH with the constructor defaults', () => {
    expect(GOOGLE_SEARCH.bypassMultiToolsLimit).toBe(false);
    expect(GOOGLE_SEARCH.model).toBeUndefined();
  });
});
