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

const FIRST_METADATA: GroundingMetadata = {
  webSearchQueries: ['first query'],
};

const SECOND_METADATA: GroundingMetadata = {
  webSearchQueries: ['second query'],
};

/** One reply the {@link ScriptedAgent} yields, as an event would carry it. */
interface ScriptedReply {
  text?: string;
  groundingMetadata?: GroundingMetadata;
}

/** A sub-agent that yields the replies it was built with, in order. */
class ScriptedAgent extends BaseAgent {
  constructor(private readonly replies: ScriptedReply[]) {
    super({name: 'scripted_agent', description: 'Yields canned replies.'});
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    for (const reply of this.replies) {
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        content:
          reply.text === undefined
            ? undefined
            : {role: 'model', parts: [{text: reply.text}]},
        groundingMetadata: reply.groundingMetadata,
      });
    }
  }

  protected override async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.runAsyncImpl(context);
  }
}

function createParentToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'parent-invocation',
      agent: new ScriptedAgent([]),
      session: createSession({
        id: 'parent-session',
        appName: 'parent-app',
        userId: 'parent-user',
      }),
      sessionService: new InMemorySessionService(),
      pluginManager: new PluginManager([]),
    }),
  });
}

async function runTool(
  replies: ScriptedReply[],
  propagateGroundingMetadata?: boolean,
): Promise<Context> {
  const toolContext = createParentToolContext();
  const tool = new AgentTool({
    agent: new ScriptedAgent(replies),
    propagateGroundingMetadata,
  });

  await tool.runAsync({args: {request: 'anything'}, toolContext});

  return toolContext;
}

describe('AgentTool propagateGroundingMetadata', () => {
  it('never writes the state key when the option is unset', async () => {
    const toolContext = await runTool([
      {text: 'grounded answer', groundingMetadata: FIRST_METADATA},
    ]);

    expect(toolContext.state.has(GROUNDING_METADATA_KEY)).toBe(false);
  });

  it('never writes the state key when the option is false', async () => {
    const toolContext = await runTool(
      [{text: 'grounded answer', groundingMetadata: FIRST_METADATA}],
      false,
    );

    expect(toolContext.state.has(GROUNDING_METADATA_KEY)).toBe(false);
  });

  it('does not write the state key when no event carries metadata', async () => {
    const toolContext = await runTool([{text: 'plain answer'}], true);

    expect(toolContext.state.has(GROUNDING_METADATA_KEY)).toBe(false);
  });

  it('publishes the metadata of the last content-bearing event', async () => {
    const toolContext = await runTool(
      [
        {text: 'first answer', groundingMetadata: FIRST_METADATA},
        {text: 'second answer', groundingMetadata: SECOND_METADATA},
      ],
      true,
    );

    expect(toolContext.state.get(GROUNDING_METADATA_KEY)).toEqual(
      SECOND_METADATA,
    );
  });

  it('writes nothing when the last content-bearing event carries no metadata', async () => {
    const toolContext = await runTool(
      [
        {text: 'first answer', groundingMetadata: FIRST_METADATA},
        {text: 'second answer'},
      ],
      true,
    );

    expect(toolContext.state.has(GROUNDING_METADATA_KEY)).toBe(false);
  });

  it('publishes the metadata of a single grounded reply', async () => {
    const toolContext = await runTool(
      [{text: 'grounded answer', groundingMetadata: FIRST_METADATA}],
      true,
    );

    expect(toolContext.state.get(GROUNDING_METADATA_KEY)).toEqual(
      FIRST_METADATA,
    );
  });
});
