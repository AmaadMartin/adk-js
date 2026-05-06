/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createEvent,
  createGoogleSearchAgent,
  createSession,
  GOOGLE_SEARCH,
  GoogleSearchAgentTool,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  PluginManager,
  Runner,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

vi.mock('../../src/runner/runner.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/runner/runner.js')>();
  return {
    ...actual,
    Runner: vi.fn().mockImplementation((config) => ({
      appName: config?.appName,
      sessionService: config?.sessionService,
      runAsync: vi.fn(),
    })),
  };
});

describe('GoogleSearchAgentTool', () => {
  describe('createGoogleSearchAgent', () => {
    it('creates an LlmAgent with google_search tool', () => {
      const agent = createGoogleSearchAgent('gemini-2.0-flash');
      expect(agent).toBeInstanceOf(LlmAgent);
      expect(agent.name).toBe('google_search_agent');
      expect(agent.model).toBe('gemini-2.0-flash');
      expect(agent.tools).toContain(GOOGLE_SEARCH);
      expect(agent.description).toContain('Google search');
    });
  });

  describe('GoogleSearchAgentTool', () => {
    it('propagates grounding metadata during invocation', async () => {
      const mockAgent = {
        name: 'google_search_agent',
      } as unknown as LlmAgent;

      const tool = new GoogleSearchAgentTool(mockAgent);

      const mockSessionService = new InMemorySessionService();
      const session = createSession({
        id: 'parent-session',
        appName: 'parent-app',
        userId: 'parent-user',
      });

      const invocationContext = new InvocationContext({
        invocationId: 'test-invocation',
        agent: mockAgent,
        session,
        pluginManager: new PluginManager([]),
        sessionService: mockSessionService,
      });

      const toolContext = new Context({
        invocationContext,
      });

      const mockGroundingMetadata = {
        webSearchQueries: ['test query'],
      };

      // Setup Runner mock to return events with grounding metadata
      const mockRunAsync = async function* () {
        yield createEvent({
          author: 'google_search_agent',
          content: {role: 'model', parts: [{text: 'search result'}]},
          groundingMetadata: mockGroundingMetadata,
        });
      };

      vi.mocked(Runner).mockImplementation((config) => {
        return {
          appName: config?.appName,
          sessionService: config?.sessionService,
          runAsync: mockRunAsync,
        } as unknown as Runner;
      });

      const result = await tool.runAsync({
        args: {request: 'test query'},
        toolContext,
      });

      expect(result).toBe('search result');

      // Verify grounding metadata is stored in the state
      expect(toolContext.state.get('temp:_adk_grounding_metadata')).toEqual(
        mockGroundingMetadata,
      );
    });
  });
});
