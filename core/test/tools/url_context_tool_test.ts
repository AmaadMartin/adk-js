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
import {Tool} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';

const MODEL_ID_CHECK_ENV_VAR = 'ADK_DISABLE_GEMINI_MODEL_ID_CHECK';

function makeRequest(
  model?: string,
  tools: Tool[] = [],
  isManagedAgent?: boolean,
): LlmRequest {
  return {
    model,
    config: {tools},
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
    isManagedAgent,
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

describe('UrlContextTool', () => {
  describe('processLlmRequest', () => {
    it('throws when model is not set', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest(undefined);

      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: makeToolContext(),
        }),
      ).rejects.toThrow(
        'URL context tool is not supported for model undefined',
      );

      expect(req.config?.tools).toEqual([]);
    });

    it('adds urlContext for Gemini 2+ model', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('gemini-2.0-flash');
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: makeToolContext(),
      });

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });

    it('adds urlContext for Gemini 2.5 model', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('gemini-2.5-pro');
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: makeToolContext(),
      });

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });

    it('adds urlContext for a Gemini 1.x model', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('gemini-1.5-pro');
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: makeToolContext(),
      });

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });

    it('throws for unsupported (non-Gemini) model', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('gpt-4');
      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: makeToolContext(),
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
      };
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: makeToolContext(),
      });

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });

    it('initializes config.tools when the config carries no tools', async () => {
      const tool = new UrlContextTool();
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

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });

    it('adds urlContext for a path-based Gemini 2 model', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest(
        'projects/265104255505/locations/us-central1/publishers/google/models/gemini-2.5-flash',
      );
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: makeToolContext(),
      });

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });

    it('appends urlContext after the tools already on the request', async () => {
      const tool = new UrlContextTool();
      const existingTool: Tool = {
        functionDeclarations: [{name: 'test_function', description: 'test'}],
      };
      const req = makeRequest('gemini-2.5-flash', [existingTool]);
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: makeToolContext(),
      });

      expect(req.config!.tools).toEqual([existingTool, {urlContext: {}}]);
    });

    it('adds urlContext for a variant-less EAP Gemini model', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('gemini-early-exp');
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: makeToolContext(),
      });

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });

    it('adds urlContext for a path-based EAP Gemini model', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest(
        'projects/265104255505/locations/global/publishers/google/models/gemini-early-exp',
      );
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: makeToolContext(),
      });

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });

    it('throws for a non-Gemini Anthropic model', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('claude-3-sonnet');

      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: makeToolContext(),
        }),
      ).rejects.toThrow(
        'URL context tool is not supported for model claude-3-sonnet',
      );
    });

    it('throws for a path-based non-Gemini model', async () => {
      const tool = new UrlContextTool();
      const model =
        'projects/265104255505/locations/us-central1/publishers/google/models/claude-3-sonnet';
      const req = makeRequest(model);

      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: makeToolContext(),
        }),
      ).rejects.toThrow(`URL context tool is not supported for model ${model}`);
    });

    it('throws when the model is empty', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('');

      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: makeToolContext(),
        }),
      ).rejects.toThrow('URL context tool is not supported for model ');
    });

    it('creates config and empty tools on the rejection path', async () => {
      const tool = new UrlContextTool();
      const req: LlmRequest = {
        model: 'gpt-4',
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
      };

      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: makeToolContext(),
        }),
      ).rejects.toThrow('URL context tool is not supported for model gpt-4');

      expect(req.config!.tools).toEqual([]);
    });

    it.each([
      'my-gemini-2.0-model',
      'custom-gemini-2.5-flash',
      'projects/265104255505/locations/us-central1/publishers/gemini/models/claude-3-sonnet',
    ])('throws for the model id %s', async (model) => {
      const tool = new UrlContextTool();
      const req = makeRequest(model);

      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: makeToolContext(),
        }),
      ).rejects.toThrow(`URL context tool is not supported for model ${model}`);
    });

    describe('ADK_DISABLE_GEMINI_MODEL_ID_CHECK', () => {
      afterEach(() => {
        vi.unstubAllEnvs();
      });

      it('adds urlContext for a non-Gemini model when the check is disabled', async () => {
        vi.stubEnv(MODEL_ID_CHECK_ENV_VAR, 'true');
        const tool = new UrlContextTool();
        const req = makeRequest('internal-model-v1');

        await tool.processLlmRequest({
          llmRequest: req,
          toolContext: makeToolContext(),
        });

        expect(req.config!.tools).toEqual([{urlContext: {}}]);
      });

      it('still throws for a non-Gemini model when the value is falsy', async () => {
        vi.stubEnv(MODEL_ID_CHECK_ENV_VAR, 'false');
        const tool = new UrlContextTool();
        const req = makeRequest('internal-model-v1');

        await expect(
          tool.processLlmRequest({
            llmRequest: req,
            toolContext: makeToolContext(),
          }),
        ).rejects.toThrow(
          'URL context tool is not supported for model internal-model-v1',
        );
      });
    });

    describe('managed-agent requests', () => {
      it('adds urlContext for a managed-agent request with no model', async () => {
        const tool = new UrlContextTool();
        const req = makeRequest(undefined, [], true);

        await tool.processLlmRequest({
          llmRequest: req,
          toolContext: makeToolContext(),
        });

        expect(req.config!.tools).toEqual([{urlContext: {}}]);
      });

      it('adds urlContext for a managed-agent request with a non-Gemini model', async () => {
        const tool = new UrlContextTool();
        const req = makeRequest('claude-3-sonnet', [], true);

        await tool.processLlmRequest({
          llmRequest: req,
          toolContext: makeToolContext(),
        });

        expect(req.config!.tools).toEqual([{urlContext: {}}]);
      });

      it('still throws for a non-Gemini model when the request is not managed', async () => {
        const tool = new UrlContextTool();
        const req = makeRequest('claude-3-sonnet', [], false);

        await expect(
          tool.processLlmRequest({
            llmRequest: req,
            toolContext: makeToolContext(),
          }),
        ).rejects.toThrow(
          'URL context tool is not supported for model claude-3-sonnet',
        );

        expect(req.config!.tools).toEqual([]);
      });
    });
  });

  it('is named and described as url_context', () => {
    const tool = new UrlContextTool();

    expect(tool.name).toBe('url_context');
    expect(tool.description).toBe('url_context');
  });

  it('has a global instance URL_CONTEXT', () => {
    expect(URL_CONTEXT).toBeInstanceOf(UrlContextTool);
    expect(URL_CONTEXT.name).toBe('url_context');
  });
});
