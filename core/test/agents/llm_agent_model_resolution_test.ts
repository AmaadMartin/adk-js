/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseLlm,
  BaseLlmConnection,
  Event,
  InMemorySessionService,
  InvocationContext,
  LiveRequestQueue,
  LlmAgent,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
  Runner,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

class FakeLlm extends BaseLlm {
  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    // No response: these tests never run the agent.
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('not used');
  }
}

/** A model that records the requests a live run connects it with. */
class RecordingLiveLlm extends FakeLlm {
  readonly connectedWith: LlmRequest[] = [];

  override async connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    this.connectedWith.push(llmRequest);
    return {
      sendHistory: async () => {},
      sendContent: async () => {},
      sendRealtime: async () => {},
      receive: async function* () {
        yield* [];
      },
      close: async () => {},
    };
  }
}

/** An agent that is not an LlmAgent, so the ancestor walk must skip it. */
class PlainAgent extends BaseAgent {
  protected async *runAsyncImpl(
    _invocationContext: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* [];
  }

  protected async *runLiveImpl(
    _invocationContext: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* [];
  }
}

/** Replaces the registry so no test builds a real model client. */
function stubRegistry() {
  return vi
    .spyOn(LLMRegistry, 'newLlm')
    .mockImplementation((model: string) => new FakeLlm({model}));
}

describe('LlmAgent.canonicalModel', () => {
  afterEach(() => {
    LlmAgent.setDefaultModel(LlmAgent.DEFAULT_MODEL);
    LlmAgent.setDefaultLiveModel(LlmAgent.DEFAULT_LIVE_MODEL);
    vi.restoreAllMocks();
  });

  it('falls back to the built-in default when no model is set', () => {
    stubRegistry();

    expect(new LlmAgent({name: 'no_model'}).canonicalModel.model).toBe(
      'gemini-3.5-flash',
    );
  });

  it('resolves the built-in default through the real registry', () => {
    vi.stubEnv('GOOGLE_API_KEY', 'test-api-key');

    expect(new LlmAgent({name: 'no_model'}).canonicalModel.model).toBe(
      LlmAgent.DEFAULT_MODEL,
    );
  });

  it('falls back to the default set by setDefaultModel', () => {
    stubRegistry();
    LlmAgent.setDefaultModel('gemini-2.5-flash');

    expect(new LlmAgent({name: 'no_model'}).canonicalModel.model).toBe(
      'gemini-2.5-flash',
    );
  });

  it('falls back to a BaseLlm default without going through the registry', () => {
    const newLlm = stubRegistry();
    const fallback = new FakeLlm({model: 'instance-default'});
    LlmAgent.setDefaultModel(fallback);

    expect(new LlmAgent({name: 'no_model'}).canonicalModel).toBe(fallback);
    expect(newLlm).not.toHaveBeenCalled();
  });

  it('resolves its own model name', () => {
    stubRegistry();

    expect(
      new LlmAgent({name: 'named', model: 'gemini-2.5-pro'}).canonicalModel
        .model,
    ).toBe('gemini-2.5-pro');
  });

  it('returns an explicit BaseLlm as it was given', () => {
    const llm = new FakeLlm({model: 'explicit'});

    expect(new LlmAgent({name: 'explicit', model: llm}).canonicalModel).toBe(
      llm,
    );
  });

  it('resolves a model name once and reuses the instance', () => {
    const newLlm = stubRegistry();
    const agent = new LlmAgent({name: 'memo', model: 'gemini-2.5-flash'});

    const first = agent.canonicalModel;

    expect(agent.canonicalModel).toBe(first);
    expect(agent.canonicalModel).toBe(first);
    expect(newLlm).toHaveBeenCalledTimes(1);
  });

  it('resolves again after the model name is reassigned', () => {
    const newLlm = stubRegistry();
    const agent = new LlmAgent({name: 'memo', model: 'gemini-2.5-flash'});
    const first = agent.canonicalModel;

    agent.model = 'gemini-2.5-pro';
    const second = agent.canonicalModel;

    expect(second).not.toBe(first);
    expect(second.model).toBe('gemini-2.5-pro');
    expect(newLlm).toHaveBeenCalledTimes(2);
  });

  it('inherits the model from its parent agent', () => {
    stubRegistry();
    const child = new LlmAgent({name: 'child'});
    new LlmAgent({
      name: 'parent',
      model: 'gemini-2.5-pro',
      subAgents: [child],
    });

    expect(child.canonicalModel.model).toBe('gemini-2.5-pro');
  });

  it('skips an ancestor that is not an LlmAgent', () => {
    stubRegistry();
    const child = new LlmAgent({name: 'child'});
    const middle = new PlainAgent({name: 'middle', subAgents: [child]});
    new LlmAgent({
      name: 'grandparent',
      model: 'gemini-2.5-pro',
      subAgents: [middle],
    });

    expect(child.canonicalModel.model).toBe('gemini-2.5-pro');
  });

  it('uses the nearest ancestor that has a model', () => {
    stubRegistry();
    const child = new LlmAgent({name: 'child'});
    const middle = new LlmAgent({
      name: 'middle',
      model: 'gemini-2.5-flash',
      subAgents: [child],
    });
    new LlmAgent({
      name: 'grandparent',
      model: 'gemini-2.5-pro',
      subAgents: [middle],
    });

    expect(child.canonicalModel.model).toBe('gemini-2.5-flash');
  });

  it('falls back to the default when no ancestor has a model', () => {
    stubRegistry();
    const child = new LlmAgent({name: 'child'});
    new LlmAgent({name: 'parent', subAgents: [child]});

    expect(child.canonicalModel.model).toBe('gemini-3.5-flash');
  });
});

describe('LlmAgent.canonicalLiveModel', () => {
  afterEach(() => {
    LlmAgent.setDefaultModel(LlmAgent.DEFAULT_MODEL);
    LlmAgent.setDefaultLiveModel(LlmAgent.DEFAULT_LIVE_MODEL);
    vi.restoreAllMocks();
  });

  it('falls back to the built-in live default when no model is set', () => {
    stubRegistry();

    expect(new LlmAgent({name: 'no_model'}).canonicalLiveModel.model).toBe(
      'gemini-live-2.5-flash-native-audio',
    );
  });

  it('falls back to the default set by setDefaultLiveModel', () => {
    stubRegistry();
    LlmAgent.setDefaultLiveModel('gemini-live-2.5-flash');

    expect(new LlmAgent({name: 'no_model'}).canonicalLiveModel.model).toBe(
      'gemini-live-2.5-flash',
    );
  });

  it('keeps the turn-by-turn default separate from the live default', () => {
    stubRegistry();
    LlmAgent.setDefaultModel('gemini-2.5-flash');
    const agent = new LlmAgent({name: 'no_model'});

    expect(agent.canonicalModel.model).toBe('gemini-2.5-flash');
    expect(agent.canonicalLiveModel.model).toBe(
      'gemini-live-2.5-flash-native-audio',
    );
  });

  it('resolves its own model name', () => {
    stubRegistry();

    expect(
      new LlmAgent({name: 'named', model: 'gemini-live-2.5-flash'})
        .canonicalLiveModel.model,
    ).toBe('gemini-live-2.5-flash');
  });

  it('returns an explicit BaseLlm as it was given', () => {
    const llm = new FakeLlm({model: 'explicit-live'});

    expect(
      new LlmAgent({name: 'explicit', model: llm}).canonicalLiveModel,
    ).toBe(llm);
  });

  it('resolves a model name once and reuses the instance', () => {
    const newLlm = stubRegistry();
    const agent = new LlmAgent({name: 'memo', model: 'gemini-live-2.5-flash'});

    const first = agent.canonicalLiveModel;

    expect(agent.canonicalLiveModel).toBe(first);
    expect(newLlm).toHaveBeenCalledTimes(1);
  });

  it('resolves again after the model name is reassigned', () => {
    stubRegistry();
    const agent = new LlmAgent({name: 'memo', model: 'gemini-live-2.5-flash'});
    const first = agent.canonicalLiveModel;

    agent.model = 'gemini-live-2.5-flash-native-audio';

    expect(agent.canonicalLiveModel).not.toBe(first);
  });

  it('keeps its memo independent of the turn-by-turn memo', () => {
    stubRegistry();
    const agent = new LlmAgent({name: 'memo', model: 'gemini-2.5-flash'});

    expect(agent.canonicalLiveModel).not.toBe(agent.canonicalModel);
  });

  it('inherits the live model from its ancestors', () => {
    stubRegistry();
    const child = new LlmAgent({name: 'child'});
    new LlmAgent({name: 'parent', subAgents: [child]});

    expect(child.canonicalLiveModel.model).toBe(
      'gemini-live-2.5-flash-native-audio',
    );
  });
});

describe('a live run', () => {
  afterEach(() => {
    LlmAgent.setDefaultModel(LlmAgent.DEFAULT_MODEL);
    LlmAgent.setDefaultLiveModel(LlmAgent.DEFAULT_LIVE_MODEL);
  });

  it('connects with the live model, not the turn-by-turn one', async () => {
    const liveLlm = new RecordingLiveLlm({model: 'live-model'});
    const turnLlm = new RecordingLiveLlm({model: 'turn-model'});
    LlmAgent.setDefaultModel(turnLlm);
    LlmAgent.setDefaultLiveModel(liveLlm);

    const sessionService = new InMemorySessionService();
    const runner = new Runner({
      appName: 'test_app',
      agent: new LlmAgent({name: 'live_agent'}),
      sessionService,
    });
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'test_user',
    });
    const queue = new LiveRequestQueue();
    queue.close();

    for await (const _event of runner.runLive({
      userId: session.userId,
      sessionId: session.id,
      liveRequestQueue: queue,
    })) {
      // Drain the stream; the queue is already closed.
    }

    expect(liveLlm.connectedWith.map((request) => request.model)).toEqual([
      'live-model',
    ]);
    expect(turnLlm.connectedWith).toHaveLength(0);
  });
});

describe('LlmAgent.setDefaultModel', () => {
  afterEach(() => {
    LlmAgent.setDefaultModel(LlmAgent.DEFAULT_MODEL);
    LlmAgent.setDefaultLiveModel(LlmAgent.DEFAULT_LIVE_MODEL);
  });

  it('rejects a value that is neither a name nor a BaseLlm', () => {
    const notAModel: unknown = 123;

    expect(() => {
      LlmAgent.setDefaultModel(notAModel as string);
    }).toThrow(/got number/);
  });

  it('names the actual type of a rejected value', () => {
    const notAModel: unknown = ['gemini-2.5-flash'];

    expect(() => {
      LlmAgent.setDefaultModel(notAModel as string);
    }).toThrow(/got object/);
  });

  it('rejects an empty model name', () => {
    expect(() => {
      LlmAgent.setDefaultModel('');
    }).toThrow(/non-empty string/);
  });

  it('rejects a live default that is neither a name nor a BaseLlm', () => {
    const notAModel: unknown = {};

    expect(() => {
      LlmAgent.setDefaultLiveModel(notAModel as string);
    }).toThrow(/got object/);
  });

  it('rejects an empty live model name', () => {
    expect(() => {
      LlmAgent.setDefaultLiveModel('');
    }).toThrow(/non-empty string/);
  });

  it('leaves the default unchanged when it rejects a value', () => {
    vi.spyOn(LLMRegistry, 'newLlm').mockImplementation(
      (model: string) => new FakeLlm({model}),
    );
    LlmAgent.setDefaultModel('gemini-2.5-flash');

    expect(() => {
      LlmAgent.setDefaultModel('');
    }).toThrow();
    expect(new LlmAgent({name: 'no_model'}).canonicalModel.model).toBe(
      'gemini-2.5-flash',
    );
    vi.restoreAllMocks();
  });
});
