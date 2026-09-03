/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  BasePlugin,
  BaseTool,
  BaseToolset,
  Context,
  createSession,
  Event,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
  ReadonlyContext,
  RunAsyncToolRequest,
} from '@google/adk';
import {GroundingMetadata} from '@google/genai';
import {describe, expect, it} from 'vitest';

const GROUNDING_STATE_KEY = 'temp:_adk_grounding_metadata';

const GROUNDING_METADATA: GroundingMetadata = {
  webSearchQueries: ['adk grounding'],
};

/** A model that answers every request with the same single response. */
class StubModel extends BaseLlm {
  constructor() {
    super({model: 'stub-model'});
  }

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void, void> {
    yield {content: {role: 'model', parts: [{text: 'model answer'}]}};
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('StubModel does not support live connections.');
  }
}

/** A tool that only needs to exist under a given name. */
class StubTool extends BaseTool {
  constructor(name: string) {
    super({name, description: `${name} stub`});
  }

  async runAsync(_request: RunAsyncToolRequest): Promise<unknown> {
    return {};
  }
}

/** A toolset that hands out whichever tools it currently holds. */
class StubToolset extends BaseToolset {
  // Its tool list changes inside one invocation, which is the case
  // `BaseToolset` tells such a subclass to opt out of the invocation cache
  // for.
  protected override useInvocationCache = false;

  constructor(public tools: BaseTool[]) {
    super([]);
  }

  async getTools(_context?: ReadonlyContext): Promise<BaseTool[]> {
    return this.tools;
  }

  async close(): Promise<void> {}
}

/**
 * An after-model callback that records the tool names cached on the
 * invocation context the flow is running, which is a clone of the context the
 * caller passed to `runAsync`.
 */
function captureCachedToolNames(): {
  callback: (params: {
    context: Context;
    response: LlmResponse;
  }) => Promise<undefined>;
  value: () => string[] | undefined;
} {
  let names: string[] | undefined;
  return {
    callback: async ({context}) => {
      names = context.invocationContext.canonicalToolsCache?.map(
        (tool) => tool.name,
      );
      return undefined;
    },
    value: () => names,
  };
}

/** A plugin whose after-model callback replaces the model's response. */
class OverridingPlugin extends BasePlugin {
  constructor(private readonly response: LlmResponse) {
    super('overriding_plugin');
  }

  async afterModelCallback(_params: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse | undefined> {
    return this.response;
  }
}

function buildContext(
  agent: LlmAgent,
  state: Record<string, unknown>,
  pluginManager = new PluginManager(),
): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv_grounding',
    session: createSession({
      id: 'session_grounding',
      appName: 'grounding_app',
      userId: 'user_1',
      state,
    }),
    agent,
    pluginManager,
  });
}

async function collect(
  agent: LlmAgent,
  invocationContext: InvocationContext,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of agent.runAsync(invocationContext)) {
    events.push(event);
  }
  return events;
}

function modelEvent(events: Event[], author: string): Event {
  const event = events.find((candidate) => candidate.author === author);
  if (!event) {
    expect.fail(`no event authored by ${author} in ${events.length} events`);
  }
  return event;
}

describe('LlmAgent grounding metadata injection', () => {
  it('adds the metadata when the search agent tool and the state key are both present', async () => {
    const agent = new LlmAgent({
      name: 'grounding_agent',
      model: new StubModel(),
      tools: [new StubTool('google_search_agent')],
    });
    const invocationContext = buildContext(agent, {
      [GROUNDING_STATE_KEY]: GROUNDING_METADATA,
    });

    const events = await collect(agent, invocationContext);

    expect(modelEvent(events, 'grounding_agent').groundingMetadata).toEqual(
      GROUNDING_METADATA,
    );
  });

  it('leaves the response alone when the agent has no search agent tool', async () => {
    const agent = new LlmAgent({
      name: 'grounding_agent',
      model: new StubModel(),
      tools: [new StubTool('other_tool')],
    });
    const invocationContext = buildContext(agent, {
      [GROUNDING_STATE_KEY]: GROUNDING_METADATA,
    });

    const events = await collect(agent, invocationContext);

    expect(
      modelEvent(events, 'grounding_agent').groundingMetadata,
    ).toBeUndefined();
  });

  it('leaves the response alone when the state key is absent', async () => {
    const agent = new LlmAgent({
      name: 'grounding_agent',
      model: new StubModel(),
      tools: [new StubTool('google_search_agent')],
    });
    const invocationContext = buildContext(agent, {});

    const events = await collect(agent, invocationContext);

    expect(
      modelEvent(events, 'grounding_agent').groundingMetadata,
    ).toBeUndefined();
  });

  it('leaves the response alone when neither the tool nor the state key is present', async () => {
    const agent = new LlmAgent({
      name: 'grounding_agent',
      model: new StubModel(),
      tools: [new StubTool('other_tool')],
    });
    const invocationContext = buildContext(agent, {});

    const events = await collect(agent, invocationContext);

    expect(
      modelEvent(events, 'grounding_agent').groundingMetadata,
    ).toBeUndefined();
  });

  it('leaves the response alone when the state key holds a falsy value', async () => {
    const agent = new LlmAgent({
      name: 'grounding_agent',
      model: new StubModel(),
      tools: [new StubTool('google_search_agent')],
    });
    const invocationContext = buildContext(agent, {
      [GROUNDING_STATE_KEY]: null,
    });

    const events = await collect(agent, invocationContext);

    expect(
      modelEvent(events, 'grounding_agent').groundingMetadata,
    ).toBeUndefined();
  });

  it('adds the metadata to the response a canonical after-model callback returned', async () => {
    const agent = new LlmAgent({
      name: 'grounding_agent',
      model: new StubModel(),
      tools: [new StubTool('google_search_agent')],
      afterModelCallback: async () => ({
        content: {role: 'model', parts: [{text: 'callback answer'}]},
      }),
    });
    const invocationContext = buildContext(agent, {
      [GROUNDING_STATE_KEY]: GROUNDING_METADATA,
    });

    const events = await collect(agent, invocationContext);
    const event = modelEvent(events, 'grounding_agent');

    expect(event.content?.parts?.[0]?.text).toBe('callback answer');
    expect(event.groundingMetadata).toEqual(GROUNDING_METADATA);
  });

  it('adds the metadata to the response a plugin after-model callback returned', async () => {
    const agent = new LlmAgent({
      name: 'grounding_agent',
      model: new StubModel(),
      tools: [new StubTool('google_search_agent')],
    });
    const pluginManager = new PluginManager();
    pluginManager.registerPlugin(
      new OverridingPlugin({
        content: {role: 'model', parts: [{text: 'plugin answer'}]},
      }),
    );
    const invocationContext = buildContext(
      agent,
      {[GROUNDING_STATE_KEY]: GROUNDING_METADATA},
      pluginManager,
    );

    const events = await collect(agent, invocationContext);
    const event = modelEvent(events, 'grounding_agent');

    expect(event.content?.parts?.[0]?.text).toBe('plugin answer');
    expect(event.groundingMetadata).toEqual(GROUNDING_METADATA);
  });

  it('caches the tools the step resolved, flattened across tool unions', async () => {
    const cachedNames = captureCachedToolNames();
    const agent = new LlmAgent({
      name: 'grounding_agent',
      model: new StubModel(),
      tools: [
        new StubToolset([
          new StubTool('toolset_tool_a'),
          new StubTool('toolset_tool_b'),
        ]),
        new StubTool('plain_tool'),
      ],
      afterModelCallback: cachedNames.callback,
    });

    await collect(agent, buildContext(agent, {}));

    expect(cachedNames.value()).toEqual([
      'toolset_tool_a',
      'toolset_tool_b',
      'plain_tool',
    ]);
  });

  it('adds the metadata when the search agent tool comes from a toolset', async () => {
    const agent = new LlmAgent({
      name: 'grounding_agent',
      model: new StubModel(),
      tools: [new StubToolset([new StubTool('google_search_agent')])],
    });
    const invocationContext = buildContext(agent, {
      [GROUNDING_STATE_KEY]: GROUNDING_METADATA,
    });

    const events = await collect(agent, invocationContext);

    expect(modelEvent(events, 'grounding_agent').groundingMetadata).toEqual(
      GROUNDING_METADATA,
    );
  });

  it('refreshes the cache on the second step of the same invocation', async () => {
    const toolset = new StubToolset([new StubTool('first_step_tool')]);
    const cachedNames = captureCachedToolNames();
    const agent = new LlmAgent({
      name: 'grounding_agent',
      model: new StubModel(),
      tools: [toolset],
      afterModelCallback: cachedNames.callback,
    });
    const invocationContext = buildContext(agent, {});

    await collect(agent, invocationContext);
    expect(cachedNames.value()).toEqual(['first_step_tool']);

    toolset.tools = [new StubTool('second_step_tool')];
    await collect(agent, buildContext(agent, {}));

    expect(cachedNames.value()).toEqual(['second_step_tool']);
  });

  it('leaves the response alone when the state key holds a non-object', async () => {
    const agent = new LlmAgent({
      name: 'grounding_agent',
      model: new StubModel(),
      tools: [new StubTool('google_search_agent')],
    });
    const invocationContext = buildContext(agent, {
      [GROUNDING_STATE_KEY]: 'not grounding metadata',
    });

    const events = await collect(agent, invocationContext);

    expect(
      modelEvent(events, 'grounding_agent').groundingMetadata,
    ).toBeUndefined();
  });

  it('caches an empty list when the agent has no tools', async () => {
    const cachedNames = captureCachedToolNames();
    const agent = new LlmAgent({
      name: 'grounding_agent',
      model: new StubModel(),
      afterModelCallback: cachedNames.callback,
    });
    const invocationContext = buildContext(agent, {
      [GROUNDING_STATE_KEY]: GROUNDING_METADATA,
    });

    const events = await collect(agent, invocationContext);

    expect(cachedNames.value()).toEqual([]);
    expect(
      modelEvent(events, 'grounding_agent').groundingMetadata,
    ).toBeUndefined();
  });
});
