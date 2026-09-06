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

const EXISTING_TOOL: Tool = {
  functionDeclarations: [{name: 'test_function', description: 'test'}],
};

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
  describe('Gemini models', () => {
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

    it('adds urlContext for a path-based Gemini model id', async () => {
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

    it('appends urlContext after an existing tool', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('gemini-2.5-flash', [EXISTING_TOOL]);
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: makeToolContext(),
      });

      expect(req.config!.tools).toEqual([EXISTING_TOOL, {urlContext: {}}]);
    });

    it('adds urlContext for an early access model id', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('gemini-early-exp');
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: makeToolContext(),
      });

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });

    it('adds urlContext for a path-based early access model id', async () => {
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

    it('adds urlContext for a Gemini 1.x model', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('gemini-1.5-pro');
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: makeToolContext(),
      });

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });
  });

  describe('rejected models', () => {
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

    it('creates config and tools before it throws', async () => {
      const tool = new UrlContextTool();
      const req: LlmRequest = {
        model: 'claude-3-sonnet',
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
      };
      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: makeToolContext(),
        }),
      ).rejects.toThrow(
        'URL context tool is not supported for model claude-3-sonnet',
      );

      expect(req.config?.tools).toEqual([]);
    });

    it('throws for a path-based non-Gemini model id', async () => {
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

    it('throws when the model is not set', async () => {
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

    it('throws for an empty model id', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('');
      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: makeToolContext(),
        }),
      ).rejects.toThrow(/^URL context tool is not supported for model $/);
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

    it('throws for a non-Gemini model when the check is enabled', async () => {
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

  describe('config normalisation', () => {
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

    it('creates config.tools when it is absent', async () => {
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
  });

  it('names the tool url_context', () => {
    const tool = new UrlContextTool();

    expect(tool.name).toBe('url_context');
    expect(tool.description).toBe('url_context');
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
