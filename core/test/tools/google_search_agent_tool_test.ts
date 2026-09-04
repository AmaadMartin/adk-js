/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The reference tests of this module, ported one for one from
 * `adk-python main — tests/unittests/tools/test_google_search_agent_tool.py`.
 * The `it(...)` strings keep the Python test names verbatim.
 */

import {
  BaseLlm,
  BaseLlmConnection,
  Context,
  createGoogleSearchAgent,
  createSession,
  GOOGLE_SEARCH,
  GoogleSearchAgentTool,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
} from '@google/adk';
import {GroundingMetadata} from '@google/genai';
import {describe, expect, it} from 'vitest';

const GROUNDING_METADATA: GroundingMetadata = {
  webSearchQueries: ['test query'],
};

const GROUNDING_METADATA_KEY = 'temp:_adk_grounding_metadata';

/** A model that replays one canned response, so no network is involved. */
class ScriptedLlm extends BaseLlm {
  constructor(private readonly response: LlmResponse) {
    super({model: 'scripted-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    yield this.response;
  }

  async connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('ScriptedLlm does not support live mode.');
  }
}

describe('google_search_agent_tool', () => {
  it('test_create_google_search_agent_only_carries_the_search_tool', () => {
    const agent = createGoogleSearchAgent('gemini-2.0-flash');

    expect(agent.name).toBe('google_search_agent');
    expect(agent.tools).toHaveLength(1);
    expect(agent.tools[0]).toBe(GOOGLE_SEARCH);
  });

  it('test_create_google_search_agent_uses_the_given_model', () => {
    const model = new ScriptedLlm({});

    const agent = createGoogleSearchAgent(model);

    expect(agent.canonicalModel).toBe(model);
  });

  it('test_grounding_metadata_is_stored_in_state_during_invocation', async () => {
    const toolAgent = new LlmAgent({
      name: 'tool_agent',
      model: new ScriptedLlm({
        content: {role: 'model', parts: [{text: 'response from tool'}]},
        groundingMetadata: GROUNDING_METADATA,
      }),
    });
    const agentTool = new GoogleSearchAgentTool(toolAgent);

    const sessionService = new InMemorySessionService();
    const toolContext = new Context({
      invocationContext: new InvocationContext({
        invocationId: 'invocation_id',
        agent: toolAgent,
        session: createSession({
          id: 'test_session',
          appName: 'test_app',
          userId: 'test_user',
        }),
        sessionService,
        pluginManager: new PluginManager([]),
      }),
    });

    const toolResult = await agentTool.runAsync({
      args: {request: 'test1'},
      toolContext,
    });

    expect(toolResult).toBe('response from tool');
    expect(toolContext.state.get(GROUNDING_METADATA_KEY)).toEqual(
      GROUNDING_METADATA,
    );
  });
});
