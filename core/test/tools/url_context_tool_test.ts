/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmRequest, URL_CONTEXT, UrlContextTool} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {createLlmRequest, createToolContext} from '../testing_utils.js';

function makeRequest(model?: string): LlmRequest {
  return createLlmRequest({model, config: {tools: []}});
}

describe('UrlContextTool', () => {
  describe('processLlmRequest', () => {
    it('returns early when model is not set', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest(undefined);
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: createToolContext(),
      });

      expect(req.config?.tools).toEqual([]);
    });

    it('adds urlContext for Gemini 2+ model', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('gemini-2.0-flash');
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: createToolContext(),
      });

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });

    it('adds urlContext for Gemini 2.5 model', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('gemini-2.5-pro');
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: createToolContext(),
      });

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });

    it('throws for Gemini 1.x model', async () => {
      const tool = new UrlContextTool();
      const req = makeRequest('gemini-1.5-pro');
      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: createToolContext(),
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
          toolContext: createToolContext(),
        }),
      ).rejects.toThrow('URL context tool is not supported for model gpt-4');
    });

    it('initializes config.tools when config is absent', async () => {
      const tool = new UrlContextTool();
      const req = createLlmRequest({model: 'gemini-2.0-flash'});
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: createToolContext(),
      });

      expect(req.config!.tools).toEqual([{urlContext: {}}]);
    });
  });

  it('has a global instance URL_CONTEXT', () => {
    expect(URL_CONTEXT).toBeInstanceOf(UrlContextTool);
  });
});
