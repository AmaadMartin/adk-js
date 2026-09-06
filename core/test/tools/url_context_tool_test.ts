/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmRequest, URL_CONTEXT, UrlContextTool} from '@google/adk';
import {Tool} from '@google/genai';
import {describe, expect, it} from 'vitest';

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
  } as unknown as LlmRequest;
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

    it('adds urlContext for a Gemini 1.x model', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('gemini-1.5-pro');
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: {} as never,
      });

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });

    it('adds urlContext for a Live model id', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('gemini-live-2.5-flash');
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: {} as never,
      });

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });

    it('adds urlContext for an early access model id', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('gemini-flash-early-exp');
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: {} as never,
      });

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });

    it('adds urlContext for a variant-less early access model id', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('gemini-early-exp');
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: {} as never,
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
        toolContext: {} as never,
      });

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });

    it('appends urlContext after existing tools', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('gemini-2.5-flash', [EXISTING_TOOL]);
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: {} as never,
      });

      expect(req.config!.tools).toEqual([EXISTING_TOOL, {urlContext: {}}]);
    });

    it('throws for a path-based non-Gemini model id', async () => {
      const tool = new UrlContextTool();
      const model =
        'projects/265104255505/locations/us-central1/publishers/google/models/claude-3-sonnet';
      const req = makeRequest(model);
      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: {} as never,
        }),
      ).rejects.toThrow(`URL context tool is not supported for model ${model}`);
    });

    it('throws for a model id that only contains gemini', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('my-gemini-2.0-model');
      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: {} as never,
        }),
      ).rejects.toThrow(
        'URL context tool is not supported for model my-gemini-2.0-model',
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
