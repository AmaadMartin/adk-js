/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTool,
  BaseLlm,
  BaseLlmConnection,
  BasePlugin,
  BaseTool,
  Context,
  createSession,
  Event,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
  Session,
} from '@google/adk';
import {GroundingMetadata} from '@google/genai';
import {describe, expect, it} from 'vitest';

const GROUNDING_STATE_KEY = 'temp:_adk_grounding_metadata';

const GROUNDING_METADATA: GroundingMetadata = {
  webSearchQueries: ['what is adk'],
};

const MODEL_TEXT = 'from the model';
const CALLBACK_TEXT = 'from the agent callback';
const PLUGIN_TEXT = 'from the plugin';

class StubLlm extends BaseLlm {
  constructor() {
    super({model: 'stub-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    yield {content: {role: 'model', parts: [{text: MODEL_TEXT}]}};
  }

  connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return Promise.reject(new Error('the stub model has no live connection'));
  }
}

/** Calls `google_search_agent` on the first step, then answers on the second. */
class CallThenAnswerLlm extends BaseLlm {
  private step = 0;

  constructor() {
    super({model: 'call-then-answer-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    if (this.step++ === 0) {
      yield {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'google_search_agent',
                args: {request: 'what is adk'},
              },
            },
          ],
        },
      };
      return;
    }
    yield {content: {role: 'model', parts: [{text: MODEL_TEXT}]}};
  }

  connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return Promise.reject(new Error('the stub model has no live connection'));
  }
}

class OverridingPlugin extends BasePlugin {
  constructor() {
    super('overriding_plugin');
  }

  override async afterModelCallback(_params: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse | undefined> {
    return {content: {role: 'model', parts: [{text: PLUGIN_TEXT}]}};
  }
}

/** A tool named `google_search_agent`, which is what the flow matches on. */
function searchAgentTool(): AgentTool {
  return new AgentTool({
    agent: new LlmAgent({name: 'google_search_agent', model: new StubLlm()}),
  });
}

function unrelatedTool(): FunctionTool {
  return new FunctionTool({
    name: 'weather',
    description: 'Reports the weather.',
    execute: async () => 'sunny',
  });
}

interface RunOptions {
  tools?: Array<AgentTool | FunctionTool>;
  groundingMetadata?: GroundingMetadata;
  plugins?: BasePlugin[];
  beforeModelCallback?: LlmAgent['beforeModelCallback'];
  afterModelCallback?: LlmAgent['afterModelCallback'];
}

function buildSession(groundingMetadata?: GroundingMetadata): Session {
  return createSession({
    id: 'session-id',
    appName: 'app',
    userId: 'user',
    state: groundingMetadata ? {[GROUNDING_STATE_KEY]: groundingMetadata} : {},
  });
}

async function runAgent(options: RunOptions = {}): Promise<Event[]> {
  const agent = new LlmAgent({
    name: 'root_agent',
    model: new StubLlm(),
    tools: options.tools ?? [],
    beforeModelCallback: options.beforeModelCallback,
    afterModelCallback: options.afterModelCallback,
  });
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    session: buildSession(options.groundingMetadata),
    agent,
    pluginManager: new PluginManager(options.plugins ?? []),
  });

  const events: Event[] = [];
  for await (const event of agent.runAsync(invocationContext)) {
    events.push(event);
  }
  return events;
}

function modelEvent(events: Event[]): Event {
  const event = events.find((candidate) => candidate.content?.parts?.length);
  if (!event) {
    expect.fail('the agent produced no event with content');
  }
  return event;
}

describe('grounding metadata injection', () => {
  describe('with no after-model callback', () => {
    it('attaches the metadata when a google_search_agent tool is present', async () => {
      const events = await runAgent({
        tools: [searchAgentTool()],
        groundingMetadata: GROUNDING_METADATA,
      });

      const event = modelEvent(events);
      expect(event.groundingMetadata).toEqual(GROUNDING_METADATA);
      expect(event.content?.parts?.[0].text).toBe(MODEL_TEXT);
    });

    it('leaves the response alone without a google_search_agent tool', async () => {
      const events = await runAgent({
        tools: [unrelatedTool()],
        groundingMetadata: GROUNDING_METADATA,
      });

      expect(modelEvent(events).groundingMetadata).toBeUndefined();
    });

    it('leaves the response alone without metadata in temp state', async () => {
      const events = await runAgent({tools: [searchAgentTool()]});

      expect(modelEvent(events).groundingMetadata).toBeUndefined();
    });

    it('leaves the response alone with neither tool nor metadata', async () => {
      const events = await runAgent({tools: [unrelatedTool()]});

      expect(modelEvent(events).groundingMetadata).toBeUndefined();
    });
  });

  describe('with an agent after-model callback', () => {
    const overridingCallback: LlmAgent['afterModelCallback'] = () => ({
      content: {role: 'model', parts: [{text: CALLBACK_TEXT}]},
    });

    it('attaches the metadata to the response the callback returned', async () => {
      const events = await runAgent({
        tools: [searchAgentTool()],
        groundingMetadata: GROUNDING_METADATA,
        afterModelCallback: overridingCallback,
      });

      const event = modelEvent(events);
      expect(event.content?.parts?.[0].text).toBe(CALLBACK_TEXT);
      expect(event.groundingMetadata).toEqual(GROUNDING_METADATA);
    });

    it('leaves the callback response alone without a search tool', async () => {
      const events = await runAgent({
        tools: [unrelatedTool()],
        groundingMetadata: GROUNDING_METADATA,
        afterModelCallback: overridingCallback,
      });

      const event = modelEvent(events);
      expect(event.content?.parts?.[0].text).toBe(CALLBACK_TEXT);
      expect(event.groundingMetadata).toBeUndefined();
    });

    it('falls through to the model response when the callback declines', async () => {
      const events = await runAgent({
        tools: [searchAgentTool()],
        groundingMetadata: GROUNDING_METADATA,
        afterModelCallback: () => undefined,
      });

      const event = modelEvent(events);
      expect(event.content?.parts?.[0].text).toBe(MODEL_TEXT);
      expect(event.groundingMetadata).toEqual(GROUNDING_METADATA);
    });
  });

  describe('with a plugin after-model callback', () => {
    it('attaches the metadata to the response the plugin returned', async () => {
      const events = await runAgent({
        tools: [searchAgentTool()],
        groundingMetadata: GROUNDING_METADATA,
        plugins: [new OverridingPlugin()],
      });

      const event = modelEvent(events);
      expect(event.content?.parts?.[0].text).toBe(PLUGIN_TEXT);
      expect(event.groundingMetadata).toEqual(GROUNDING_METADATA);
    });

    it('leaves the plugin response alone without a search tool', async () => {
      const events = await runAgent({
        tools: [unrelatedTool()],
        groundingMetadata: GROUNDING_METADATA,
        plugins: [new OverridingPlugin()],
      });

      const event = modelEvent(events);
      expect(event.content?.parts?.[0].text).toBe(PLUGIN_TEXT);
      expect(event.groundingMetadata).toBeUndefined();
    });
  });

  it('ignores an empty grounding metadata object', async () => {
    const events = await runAgent({
      tools: [searchAgentTool()],
      groundingMetadata: {},
    });

    expect(modelEvent(events).groundingMetadata).toBeUndefined();
  });

  it('ignores a grounding metadata value that is not an object', async () => {
    const agent = new LlmAgent({
      name: 'root_agent',
      model: new StubLlm(),
      tools: [searchAgentTool()],
    });
    const invocationContext = new InvocationContext({
      invocationId: 'inv-1',
      session: createSession({
        id: 'session-id',
        appName: 'app',
        userId: 'user',
        state: {[GROUNDING_STATE_KEY]: 'not an object'},
      }),
      agent,
      pluginManager: new PluginManager(),
    });

    const events: Event[] = [];
    for await (const event of agent.runAsync(invocationContext)) {
      events.push(event);
    }

    expect(modelEvent(events).groundingMetadata).toBeUndefined();
  });
});

describe('a search tool that writes its own metadata', () => {
  it('grounds the response of the step after the tool ran', async () => {
    // The shape the developer guide documents: one tool both carries the name
    // the flow matches on and writes the metadata into temp state.
    const searchTool = new FunctionTool({
      name: 'google_search_agent',
      description: 'Answers a question with a web search.',
      execute: async (_args, toolContext) => {
        toolContext?.state.set(GROUNDING_STATE_KEY, GROUNDING_METADATA);
        return 'ADK is an agent development kit.';
      },
    });
    const agent = new LlmAgent({
      name: 'root_agent',
      model: new CallThenAnswerLlm(),
      tools: [searchTool],
    });
    const invocationContext = new InvocationContext({
      invocationId: 'inv-1',
      session: buildSession(),
      agent,
      pluginManager: new PluginManager(),
    });

    const events: Event[] = [];
    for await (const event of agent.runAsync(invocationContext)) {
      events.push(event);
    }

    const answer = events.find(
      (event) => event.content?.parts?.[0].text === MODEL_TEXT,
    );
    if (!answer) {
      expect.fail('the agent never produced its final answer');
    }
    expect(answer.groundingMetadata).toEqual(GROUNDING_METADATA);
  });
});

describe('canonicalToolsCache', () => {
  it('holds the tools preprocessing resolved, before the model is called', async () => {
    const tool = searchAgentTool();
    let cacheBeforeModelCall: BaseTool[] | undefined;
    const events = await runAgent({
      tools: [tool],
      groundingMetadata: GROUNDING_METADATA,
      beforeModelCallback: ({context}) => {
        // Only the preprocess pass can have filled the cache by now, so this
        // pins that write rather than the grounding lookup's own fallback.
        cacheBeforeModelCall = context.invocationContext.canonicalToolsCache;
        return undefined;
      },
    });

    expect(modelEvent(events).groundingMetadata).toEqual(GROUNDING_METADATA);
    expect(cacheBeforeModelCall).toEqual([tool]);
  });

  it('is filled on demand when the cache is empty', async () => {
    let stepContext: InvocationContext | undefined;
    const events = await runAgent({
      tools: [searchAgentTool()],
      groundingMetadata: GROUNDING_METADATA,
      afterModelCallback: ({context}) => {
        // Clear the cache the preprocess pass filled, so the grounding lookup
        // has to resolve the tools itself.
        context.invocationContext.canonicalToolsCache = undefined;
        stepContext = context.invocationContext;
        return undefined;
      },
    });

    expect(modelEvent(events).groundingMetadata).toEqual(GROUNDING_METADATA);
    expect(stepContext?.canonicalToolsCache?.map((tool) => tool.name)).toEqual([
      'google_search_agent',
    ]);
  });
});
