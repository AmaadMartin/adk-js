/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createGoogleSearchAgent,
  GoogleSearchAgentTool,
  isAgentTool,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('createGoogleSearchAgent', () => {
  it('describes itself the way adk-python describes the same agent', () => {
    const agent = createGoogleSearchAgent('gemini-2.5-flash');

    expect(agent.description).toBe(
      'An agent for performing Google search using the `google_search` tool',
    );
  });

  it('instructs the sub-agent to search and nothing else', () => {
    const agent = createGoogleSearchAgent('gemini-2.5-flash');

    expect(agent.instruction).toContain(
      'You are a specialized Google search agent.',
    );
    expect(agent.instruction).toContain(
      'When given a search query, use the `google_search` tool to find the related information.',
    );
  });

  it('passes a model name through untouched', () => {
    const agent = createGoogleSearchAgent('gemini-2.5-flash');

    expect(agent.model).toBe('gemini-2.5-flash');
  });
});

describe('GoogleSearchAgentTool', () => {
  it('is an agent tool named after the agent it wraps', () => {
    const tool = new GoogleSearchAgentTool(
      createGoogleSearchAgent('gemini-2.5-flash'),
    );

    expect(isAgentTool(tool)).toBe(true);
    expect(tool.name).toBe('google_search_agent');
  });

  it('takes its description from the agent it wraps', () => {
    const tool = new GoogleSearchAgentTool(
      createGoogleSearchAgent('gemini-2.5-flash'),
    );

    expect(tool.description).toBe(
      'An agent for performing Google search using the `google_search` tool',
    );
  });
});
