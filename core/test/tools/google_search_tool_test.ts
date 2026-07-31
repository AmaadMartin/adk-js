/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GOOGLE_SEARCH, GoogleSearchTool, LlmRequest} from '@google/adk';
import {Tool} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {createLlmRequest, createToolContext} from '../testing_utils.js';

function makeRequest(model?: string, tools: Tool[] = []): LlmRequest {
  return createLlmRequest({model, config: {tools}});
}

describe('GoogleSearchTool', () => {
  describe('processLlmRequest', () => {
    it('returns early when model is not set', async () => {
      const tool = new GoogleSearchTool();
      const req = makeRequest(undefined);
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: createToolContext(),
      });

      expect(req.config?.tools).toEqual([]);
    });

    it('adds googleSearchRetrieval for Gemini 1.x model', async () => {
      const tool = new GoogleSearchTool();
      const req = makeRequest('gemini-1.5-pro');
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: createToolContext(),
      });

      expect(req.config!.tools).toEqual([{googleSearchRetrieval: {}}]);
    });

    it('throws when Gemini 1.x model already has other tools', async () => {
      const tool = new GoogleSearchTool();
      const req = makeRequest('gemini-1.5-pro', [{functionDeclarations: []}]);
      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: createToolContext(),
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
        toolContext: createToolContext(),
      });

      expect(req.config!.tools).toEqual([{googleSearch: {}}]);
    });

    it('throws for unsupported (non-Gemini) model', async () => {
      const tool = new GoogleSearchTool();
      const req = makeRequest('gpt-4');
      await expect(
        tool.processLlmRequest({
          llmRequest: req,
          toolContext: createToolContext(),
        }),
      ).rejects.toThrow('Google search tool is not supported for model gpt-4');
    });

    it('initializes config.tools when config is absent', async () => {
      const tool = new GoogleSearchTool();
      const req = createLlmRequest({model: 'gemini-2.0-flash'});
      await tool.processLlmRequest({
        llmRequest: req,
        toolContext: createToolContext(),
      });

      expect(req.config!.tools).toEqual([{googleSearch: {}}]);
    });
  });

  it('has a global instance GOOGLE_SEARCH', () => {
    expect(GOOGLE_SEARCH).toBeInstanceOf(GoogleSearchTool);
  });
});
