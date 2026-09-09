/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTool,
  BaseAgent,
  Context,
  createEvent,
  createSession,
  Event,
  InMemorySessionService,
  InvocationContext,
  PluginManager,
} from '@google/adk';
import {GroundingMetadata} from '@google/genai';
import {describe, expect, it} from 'vitest';

const GROUNDING_METADATA_KEY = 'temp:_adk_grounding_metadata';

const GROUNDING: GroundingMetadata = {
  webSearchQueries: ['adk agent tool'],
  groundingChunks: [{web: {uri: 'https://example.com/a', title: 'Example A'}}],
};

/** A sub-agent that answers with grounding metadata, like a search agent. */
class GroundedAgent extends BaseAgent {
  constructor() {
    super({name: 'grounded_agent', description: 'Answers with citations.'});
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'Example A says yes.'}]},
      groundingMetadata: GROUNDING,
    });
  }

  protected override async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.runAsyncImpl(context);
  }
}

/** A tool context wired to a real session service, as a live run would be. */
function createParentToolContext(): Context {
  const sessionService = new InMemorySessionService();
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'parent-invocation',
      agent: new GroundedAgent(),
      session: createSession({
        id: 'parent-session',
        appName: 'parent-app',
        userId: 'parent-user',
      }),
      sessionService,
      pluginManager: new PluginManager([]),
    }),
  });
}

describe('AgentTool grounding metadata propagation', () => {
  it('publishes the sub-agent grounding metadata through a real runner', async () => {
    const toolContext = createParentToolContext();
    const tool = new AgentTool({
      agent: new GroundedAgent(),
      propagateGroundingMetadata: true,
    });

    const result = await tool.runAsync({
      args: {request: 'does Example A say yes?'},
      toolContext,
    });

    expect(result).toBe('Example A says yes.');
    expect(toolContext.state.get(GROUNDING_METADATA_KEY)).toEqual(GROUNDING);
    expect(
      toolContext.invocationContext.session.state[GROUNDING_METADATA_KEY],
    ).toEqual(GROUNDING);
  });

  it('leaves the parent state untouched through a real runner by default', async () => {
    const toolContext = createParentToolContext();
    const tool = new AgentTool({agent: new GroundedAgent()});

    const result = await tool.runAsync({
      args: {request: 'does Example A say yes?'},
      toolContext,
    });

    expect(result).toBe('Example A says yes.');
    expect(toolContext.state.has(GROUNDING_METADATA_KEY)).toBe(false);
    expect(toolContext.invocationContext.session.state).not.toHaveProperty(
      GROUNDING_METADATA_KEY,
    );
  });
});
