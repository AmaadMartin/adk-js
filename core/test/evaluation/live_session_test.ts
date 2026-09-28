/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BasePlugin,
  Context,
  createEvent,
  Event,
  FunctionTool,
  InMemorySessionService,
  InputValidationError,
  InvocationContext,
  LiveRequest,
  LiveRequestQueue,
  LlmAgent,
  LlmAgentConfig,
  LlmRequest,
  LlmResponse,
  Runner,
  SequentialAgent,
  Session,
  Workflow,
} from '@google/adk';
import {Modality, Part} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {BaseLlmRequestProcessor} from '../../src/agents/processors/base_llm_processor.js';
import {createRunConfig} from '../../src/agents/run_config.js';
import {
  assertLiveRootSupported,
  CONSUME_TIMEOUT_MS,
  EvalLiveSession,
  isNormalLiveClosure,
  LIVE_RUN_CONFIG,
} from '../../src/evaluation/live_session.js';

import {LongRunningFunctionTool} from '../../src/tools/long_running_tool.js';

import {ScriptedLlm} from './test_helpers.js';

/**
 * A model for a stub agent. Nothing in this suite opens a connection, but a
 * model name would resolve through the registry, which needs credentials.
 */
function stubModel(): ScriptedLlm {
  return new ScriptedLlm(['unused']);
}

const APP_NAME = 'live_eval_app';
const USER_ID = 'live_eval_user';

/** Replays a fixed event stream in place of a real live flow. */
class ScriptedLiveAgent extends LlmAgent {
  /** The contexts `runLive` was driven with, in call order. */
  readonly liveContexts: InvocationContext[] = [];

  constructor(
    config: LlmAgentConfig,
    private readonly script: () => AsyncGenerator<Event>,
  ) {
    super(config);
  }

  protected override async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    this.liveContexts.push(context);
    yield* this.script();
  }
}

/**
 * A request processor that emits an event and narrows the allowed tools, so
 * the request replay is exercised the way a real preprocessing pass is.
 */
class NarrowingRequestProcessor extends BaseLlmRequestProcessor {
  constructor(private readonly allowedTools: string[]) {
    super();
  }

  override async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    llmRequest.allowedTools = this.allowedTools;
    yield createEvent({
      author: 'preprocessor',
      invocationId: invocationContext.invocationId,
    });
  }
}

/** Counts the events the live driver hands to the session service. */
class RecordingSessionService extends InMemorySessionService {
  readonly appended: Event[] = [];

  override async appendEvent(request: {
    session: Session;
    event: Event;
  }): Promise<Event> {
    this.appended.push(request.event);
    return super.appendEvent(request);
  }
}

/** Records the model callbacks the live driver fires by hand. */
class CallbackRecorderPlugin extends BasePlugin {
  readonly beforeModelCalls: Array<{
    callbackContext: Context;
    llmRequest: LlmRequest;
  }> = [];
  readonly afterModelCalls: Array<{
    callbackContext: Context;
    llmResponse: LlmResponse;
  }> = [];

  override async beforeModelCallback(params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    this.beforeModelCalls.push(params);
    return;
  }

  override async afterModelCallback(params: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse | undefined> {
    this.afterModelCalls.push(params);
    return;
  }
}

/** An error carrying a WebSocket close code under the given field. */
function closureError(
  field: 'code' | 'status' | 'closeCode',
  value: number,
): Error {
  return Object.assign(new Error(`closed with ${value}`), {[field]: value});
}

function agentEvent(params: {
  author?: string;
  text?: string;
  functionCall?: {name: string; id?: string};
  turnComplete?: boolean;
  partial?: boolean;
}): Event {
  const parts: Part[] = [];
  if (params.text !== undefined) {
    parts.push({text: params.text});
  }
  if (params.functionCall !== undefined) {
    parts.push({
      functionCall: {
        name: params.functionCall.name,
        id: params.functionCall.id,
      },
    });
  }
  return createEvent({
    author: params.author ?? 'agent',
    invocationId: 'stream_invocation',
    content: parts.length > 0 ? {parts} : undefined,
    turnComplete: params.turnComplete,
    partial: params.partial,
  });
}

function scriptOf(...events: Event[]): () => AsyncGenerator<Event> {
  return async function* () {
    for (const event of events) {
      yield event;
    }
  };
}

/** Yields one event, then fails the stream with `error`. */
function failingScript(error: unknown): () => AsyncGenerator<Event> {
  return async function* () {
    yield agentEvent({text: 'partial transcript'});
    throw error;
  };
}

async function newSession(
  sessionService: InMemorySessionService,
): Promise<Session> {
  return sessionService.createSession({appName: APP_NAME, userId: USER_ID});
}

/** Closes the queue and returns everything queued before the close marker. */
async function drainLiveRequests(
  queue: LiveRequestQueue,
): Promise<LiveRequest[]> {
  queue.close();
  const requests: LiveRequest[] = [];
  for await (const request of queue) {
    if (request.close) {
      break;
    }
    requests.push(request);
  }
  return requests;
}

/** Builds a session driven by an agent root's own live flow. */
async function newAgentSession(params: {
  agent: BaseAgent;
  plugins?: BasePlugin[];
}): Promise<{
  session: EvalLiveSession;
  stored: Session;
  sessionService: RecordingSessionService;
}> {
  const sessionService = new RecordingSessionService();
  const stored = await newSession(sessionService);
  const runner = new Runner({
    appName: APP_NAME,
    agent: params.agent,
    sessionService,
    plugins: params.plugins,
  });
  return {
    session: new EvalLiveSession(runner, stored, USER_ID, stored.id),
    stored,
    sessionService,
  };
}

describe('isNormalLiveClosure', () => {
  it.each(['code', 'status', 'closeCode'] as const)(
    'accepts a normal closure reported as `%s`',
    (field) => {
      expect(isNormalLiveClosure(closureError(field, 1000))).toBe(true);
    },
  );

  it.each(['code', 'status', 'closeCode'] as const)(
    'rejects an abnormal closure reported as `%s`',
    (field) => {
      expect(isNormalLiveClosure(closureError(field, 1011))).toBe(false);
    },
  );

  it('rejects an error carrying no close code', () => {
    expect(isNormalLiveClosure(new Error('network down'))).toBe(false);
  });

  it('rejects values that are not objects', () => {
    expect(isNormalLiveClosure(null)).toBe(false);
    expect(isNormalLiveClosure(1000)).toBe(false);
    expect(isNormalLiveClosure(undefined)).toBe(false);
  });
});

describe('LIVE_RUN_CONFIG', () => {
  it('asks for audio out, both transcriptions, and no server-side VAD', () => {
    expect(LIVE_RUN_CONFIG.responseModalities).toEqual([Modality.AUDIO]);
    expect(LIVE_RUN_CONFIG.outputAudioTranscription).toEqual({});
    expect(LIVE_RUN_CONFIG.inputAudioTranscription).toEqual({});
    expect(
      LIVE_RUN_CONFIG.realtimeInputConfig?.automaticActivityDetection?.disabled,
    ).toBe(true);
  });

  it('is accepted by the runner run config, which rejects BIDI', () => {
    expect(() => createRunConfig(LIVE_RUN_CONFIG)).not.toThrow();
    expect(LIVE_RUN_CONFIG.streamingMode).toBeUndefined();
  });
});

describe('EvalLiveSession agent routing', () => {
  it('fires the model callbacks the live flow does not fire itself', async () => {
    const plugin = new CallbackRecorderPlugin('callback_recorder');
    const event = agentEvent({text: 'Hello', turnComplete: true});
    const agent = new ScriptedLiveAgent(
      {name: 'test_agent', model: stubModel(), instruction: 'be helpful'},
      scriptOf(event),
    );
    const {session} = await newAgentSession({agent, plugins: [plugin]});

    await session.consumeEvents();

    expect(plugin.beforeModelCalls).toHaveLength(1);
    expect(
      plugin.beforeModelCalls[0].llmRequest.config?.systemInstruction,
    ).toContain('be helpful');
    expect(plugin.afterModelCalls).toHaveLength(1);
    expect(plugin.afterModelCalls[0].llmResponse).toBe(event);
    expect(plugin.afterModelCalls[0].callbackContext).toBe(
      plugin.beforeModelCalls[0].callbackContext,
    );
  });

  it('records the tool declarations the model was shown', async () => {
    const plugin = new CallbackRecorderPlugin('callback_recorder');
    const agent = new ScriptedLiveAgent(
      {
        name: 'test_agent',
        model: stubModel(),
        instruction: 'be helpful',
        tools: [
          new FunctionTool({
            name: 'get_weather',
            description: 'Get weather details',
            execute: () => ({temperature: 20}),
          }),
        ],
      },
      scriptOf(agentEvent({text: 'Hello', turnComplete: true})),
    );
    const {session} = await newAgentSession({agent, plugins: [plugin]});

    await session.consumeEvents();

    const tools = plugin.beforeModelCalls[0].llmRequest.config?.tools ?? [];
    expect(tools).toHaveLength(1);
    expect(
      tools.flatMap((tool) =>
        'functionDeclarations' in tool
          ? (tool.functionDeclarations ?? []).map((decl) => decl.name)
          : [],
      ),
    ).toEqual(['get_weather']);
  });

  it('resolves the run config, so the run-wide call cap is enforced', async () => {
    const agent = new ScriptedLiveAgent(
      {name: 'test_agent', model: stubModel()},
      scriptOf(agentEvent({text: 'Hello', turnComplete: true})),
    );
    const {session} = await newAgentSession({agent});

    await session.consumeEvents();

    const runConfig = agent.liveContexts[0].runConfig;
    expect(runConfig?.maxLlmCalls).toBe(createRunConfig().maxLlmCalls);
    expect(runConfig?.responseModalities).toEqual([Modality.AUDIO]);
  });

  it('stamps the turn invocation id onto every event', async () => {
    const agent = new ScriptedLiveAgent(
      {name: 'test_agent', model: stubModel()},
      scriptOf(
        agentEvent({text: 'one'}),
        agentEvent({text: 'two', turnComplete: true}),
      ),
    );
    const {session} = await newAgentSession({agent});
    session.startTurn();

    await session.consumeEvents();

    const queued = session.eventQueue.splice(0);
    expect(queued.map((event) => event.invocationId)).toEqual([
      session.currentInvocationId,
      session.currentInvocationId,
    ]);
  });

  it('appends the non-partial events to the session, and only those', async () => {
    const agent = new ScriptedLiveAgent(
      {name: 'test_agent', model: stubModel()},
      scriptOf(
        agentEvent({text: 'draft', partial: true}),
        agentEvent({text: 'final', turnComplete: true}),
      ),
    );
    const {session, stored, sessionService} = await newAgentSession({agent});

    await session.consumeEvents();

    // The driver never hands a partial event over, so the session service is
    // not asked to discard one.
    expect(
      sessionService.appended.map((event) => event.content?.parts?.[0].text),
    ).toEqual(['final']);
    expect(
      stored.events.map((event) => event.content?.parts?.[0].text),
    ).toEqual(['final']);
  });

  it('runs the tools a live event asks for and returns the responses', async () => {
    let toolCalls = 0;
    const agent = new ScriptedLiveAgent(
      {
        name: 'test_agent',
        model: stubModel(),
        tools: [
          new FunctionTool({
            name: 'get_weather',
            description: 'Get weather details',
            execute: () => {
              toolCalls++;
              return {temperature: 20};
            },
          }),
        ],
      },
      scriptOf(
        agentEvent({functionCall: {name: 'get_weather', id: 'call-1'}}),
        agentEvent({text: 'It is 20 degrees.', turnComplete: true}),
      ),
    );
    const {session} = await newAgentSession({agent});

    await session.consumeEvents();

    expect(toolCalls).toBe(1);
    const requests = await drainLiveRequests(session.liveRequestQueue);
    expect(requests).toHaveLength(1);
    expect(requests[0].content?.role).toBe('tool');
    expect(requests[0].content?.parts?.[0].functionResponse?.name).toBe(
      'get_weather',
    );
  });

  it('answers every call with an error when the tool loop throws', async () => {
    const agent = new ScriptedLiveAgent(
      {
        name: 'test_agent',
        model: stubModel(),
        tools: [
          new FunctionTool({
            name: 'get_weather',
            description: 'Get weather details',
            execute: () => ({temperature: 20}),
          }),
        ],
        beforeToolCallback: () => {
          throw new Error('tool gate rejected the call');
        },
      },
      scriptOf(
        agentEvent({functionCall: {name: 'get_weather', id: 'call-1'}}),
        agentEvent({text: 'Sorry, I could not check.', turnComplete: true}),
      ),
    );
    const {session} = await newAgentSession({agent});

    // The run continues past the failure and reaches the closing turn.
    await session.consumeEvents();
    await expect(session.turnComplete).resolves.toBeUndefined();

    const requests = await drainLiveRequests(session.liveRequestQueue);
    expect(requests).toHaveLength(1);
    const functionResponse = requests[0].content?.parts?.[0].functionResponse;
    expect(functionResponse?.name).toBe('get_weather');
    expect(functionResponse?.id).toBe('call-1');
    expect(functionResponse?.response).toEqual({
      error: 'tool gate rejected the call',
    });
  });

  it('drops the preprocessing events and honours the allowed tools', async () => {
    const plugin = new CallbackRecorderPlugin('callback_recorder');
    const agent = new ScriptedLiveAgent(
      {
        name: 'test_agent',
        model: stubModel(),
        requestProcessors: [new NarrowingRequestProcessor(['other_tool'])],
        tools: [
          new FunctionTool({
            name: 'get_weather',
            description: 'Get weather details',
            execute: () => ({temperature: 20}),
          }),
        ],
      },
      scriptOf(agentEvent({text: 'Hello', turnComplete: true})),
    );
    const {session} = await newAgentSession({agent, plugins: [plugin]});

    await session.consumeEvents();

    // The processor's own event belongs to a real run, not to the replay.
    expect(session.eventQueue.splice(0)).toHaveLength(1);
    expect(plugin.beforeModelCalls[0].llmRequest.config?.tools).toBeUndefined();
  });

  it('swallows the turn complete that accompanies a tool call', async () => {
    let reachedPause: (() => void) | undefined;
    const atPause = new Promise<void>((resolve) => {
      reachedPause = resolve;
    });
    let resumeAgent: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => {
      resumeAgent = resolve;
    });
    const agent = new ScriptedLiveAgent(
      {
        name: 'test_agent',
        model: stubModel(),
        tools: [
          new FunctionTool({
            name: 'get_weather',
            description: 'Get weather details',
            execute: () => ({temperature: 20}),
          }),
        ],
      },
      async function* () {
        yield agentEvent({
          author: 'test_agent',
          functionCall: {name: 'get_weather', id: 'call-1'},
        });
        yield agentEvent({author: 'test_agent', turnComplete: true});
        reachedPause?.();
        await paused;
        yield agentEvent({
          author: 'test_agent',
          text: 'It is 20 degrees.',
          turnComplete: true,
        });
      },
    );
    const {session} = await newAgentSession({agent});

    const consuming = session.consumeEvents();
    await atPause;

    // The tool call's own turn complete is not the end of the turn.
    await expect(
      Promise.race([session.turnComplete, Promise.resolve('pending')]),
    ).resolves.toBe('pending');

    resumeAgent?.();
    await consuming;
    await expect(session.turnComplete).resolves.toBeUndefined();
  });

  it('sends nothing back when every call the model made is deferred', async () => {
    const agent = new ScriptedLiveAgent(
      {
        name: 'test_agent',
        model: stubModel(),
        tools: [
          new LongRunningFunctionTool({
            name: 'book_flight',
            description: 'Book a flight, eventually',
            execute: () => undefined,
          }),
        ],
      },
      scriptOf(
        agentEvent({functionCall: {name: 'book_flight', id: 'call-1'}}),
        agentEvent({text: 'Working on it.', turnComplete: true}),
      ),
    );
    const {session} = await newAgentSession({agent});

    await session.consumeEvents();

    expect(await drainLiveRequests(session.liveRequestQueue)).toEqual([]);
  });

  it('takes the tools and the tool callbacks from the root agent', async () => {
    const fired: string[] = [];
    const child = new ScriptedLiveAgent(
      {
        name: 'child',
        model: stubModel(),
        beforeToolCallback: () => {
          fired.push('child');
          return undefined;
        },
      },
      scriptOf(
        agentEvent({
          author: 'child',
          functionCall: {name: 'get_weather', id: 'call-1'},
        }),
        agentEvent({author: 'child', turnComplete: true}),
      ),
    );
    const root = new LlmAgent({
      name: 'parent',
      model: stubModel(),
      subAgents: [child],
      tools: [
        new FunctionTool({
          name: 'get_weather',
          description: 'Get weather details',
          execute: () => ({temperature: 20}),
        }),
      ],
      beforeToolCallback: () => {
        fired.push('parent');
        return undefined;
      },
    });

    const sessionService = new InMemorySessionService();
    const stored = await newSession(sessionService);
    // Resumption resolves the child, so the agent driven and the root the
    // tools come from are different objects.
    for (const event of [
      createEvent({
        author: 'child',
        invocationId: 'previous',
        content: {parts: [{functionCall: {name: 'get_weather', id: 'c1'}}]},
      }),
      createEvent({
        author: 'child',
        invocationId: 'previous',
        content: {parts: [{functionResponse: {name: 'get_weather', id: 'c1'}}]},
      }),
    ]) {
      await sessionService.appendEvent({session: stored, event});
    }
    const runner = new Runner({
      appName: APP_NAME,
      agent: root,
      sessionService,
      resumabilityConfig: {isResumable: true},
    });
    const session = new EvalLiveSession(runner, stored, USER_ID, stored.id);

    await session.consumeEvents();

    expect(child.liveContexts).toHaveLength(1);
    expect(fired).toEqual(['parent']);
    const requests = await drainLiveRequests(session.liveRequestQueue);
    expect(requests[0].content?.parts?.[0].functionResponse?.name).toBe(
      'get_weather',
    );
  });

  it('answers an unresolvable call when the root holds no tools', async () => {
    const sessionService = new InMemorySessionService();
    const child = new ScriptedLiveAgent(
      {name: 'child', model: stubModel()},
      scriptOf(
        agentEvent({
          author: 'child',
          functionCall: {name: 'get_weather', id: 'call-1'},
        }),
        agentEvent({author: 'child', turnComplete: true}),
      ),
    );
    const stored = await newSession(sessionService);
    // Resumption resolves the child, so the root the tools come from stays
    // the pipeline, which holds none.
    for (const event of [
      createEvent({
        author: 'child',
        invocationId: 'previous',
        content: {parts: [{functionCall: {name: 'get_weather', id: 'c1'}}]},
      }),
      createEvent({
        author: 'child',
        invocationId: 'previous',
        content: {
          parts: [{functionResponse: {name: 'get_weather', id: 'c1'}}],
        },
      }),
    ]) {
      await sessionService.appendEvent({session: stored, event});
    }
    const runner = new Runner({
      appName: APP_NAME,
      agent: new SequentialAgent({name: 'pipeline', subAgents: [child]}),
      sessionService,
      resumabilityConfig: {isResumable: true},
    });
    const session = new EvalLiveSession(runner, stored, USER_ID, stored.id);

    await session.consumeEvents();

    const requests = await drainLiveRequests(session.liveRequestQueue);
    expect(requests).toHaveLength(1);
    expect(requests[0].content?.parts?.[0].functionResponse?.name).toBe(
      'get_weather',
    );
  });

  it('rejects a resolved root that is not an LlmAgent', async () => {
    const {session} = await newAgentSession({
      agent: new SequentialAgent({
        name: 'pipeline',
        subAgents: [new LlmAgent({name: 'child', model: stubModel()})],
      }),
    });

    await expect(session.consumeEvents()).rejects.toThrow(
      "Cannot drive agent 'pipeline' via the LlmAgent live flow",
    );
  });
});

describe('live evaluation of a workflow root', () => {
  function newWorkflowRoot(): Workflow {
    return new Workflow({
      name: 'stub_workflow',
      edges: [['START', new LlmAgent({name: 'greeter', model: stubModel()})]],
    });
  }

  it('is refused up front, naming the runner limitation', () => {
    expect(() => assertLiveRootSupported(newWorkflowRoot())).toThrowError(
      InputValidationError,
    );
    expect(() => assertLiveRootSupported(newWorkflowRoot())).toThrow(
      'Live evaluation needs an agent root.',
    );
  });

  it('accepts an agent root', () => {
    expect(() =>
      assertLiveRootSupported(new LlmAgent({name: 'solo', model: stubModel()})),
    ).not.toThrow();
  });

  it('is refused by the session too, not just by the entry point', async () => {
    const sessionService = new InMemorySessionService();
    const stored = await newSession(sessionService);
    const runner = new Runner({
      appName: APP_NAME,
      agent: newWorkflowRoot(),
      sessionService,
    });
    const session = new EvalLiveSession(runner, stored, USER_ID, stored.id);

    await expect(session.consumeEvents()).rejects.toThrow(
      'Live evaluation needs an agent root.',
    );
  });
});

describe('EvalLiveSession lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A session over an agent replaying `script`. */
  async function newScriptedSession(script: () => AsyncGenerator<Event>) {
    const agent = new ScriptedLiveAgent(
      {name: 'test_agent', model: stubModel()},
      script,
    );
    const {session, sessionService} = await newAgentSession({agent});
    return {session, sessionService, agent};
  }

  it('refuses to close a session that was never started', async () => {
    const {session} = await newScriptedSession(scriptOf());

    await expect(session.close()).rejects.toThrow(
      'closed before it was started',
    );
  });

  it('starts one consumer however often start is called', async () => {
    const {session, agent} = await newScriptedSession(
      scriptOf(agentEvent({text: 'Hi', turnComplete: true})),
    );

    session.start();
    session.start();
    await session.close();

    expect(agent.liveContexts).toHaveLength(1);
  });

  it('closes the request queue and waits for the consumer', async () => {
    const {session} = await newScriptedSession(
      scriptOf(agentEvent({text: 'Hi', turnComplete: true})),
    );

    session.start();
    await session.close();

    expect(session.isFinished).toBe(true);
    expect(() => session.liveRequestQueue.sendContent({parts: []})).toThrow();
  });

  it('swallows a normal closure the consumer failed with', async () => {
    const {session} = await newScriptedSession(
      failingScript(closureError('code', 1000)),
    );

    session.start();

    await expect(session.close()).resolves.toBeUndefined();
    // The transcript collected before the close is kept.
    expect(session.eventQueue).toHaveLength(1);
  });

  it('propagates an abnormal closure the consumer failed with', async () => {
    const {session} = await newScriptedSession(
      failingScript(closureError('code', 1011)),
    );

    session.start();

    await expect(session.close()).rejects.toThrow('closed with 1011');
  });

  it('aborts a consumer that outlives the close timeout', async () => {
    vi.useFakeTimers();
    let releaseConsumer: (() => void) | undefined;
    const stalled = new Promise<void>((resolve) => {
      releaseConsumer = resolve;
    });
    const {session, sessionService, agent} = await newScriptedSession(
      async function* () {
        await stalled;
        yield agentEvent({text: 'late', turnComplete: true});
      },
    );

    session.start();
    const closing = session.close();
    await vi.advanceTimersByTimeAsync(CONSUME_TIMEOUT_MS);

    await expect(closing).resolves.toBeUndefined();
    expect(session.isFinished).toBe(false);
    expect(agent.liveContexts[0].abortSignal?.aborted).toBe(true);

    // The abandoned consumer must not keep writing once `close` has returned.
    releaseConsumer?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.eventQueue).toEqual([]);
    expect(sessionService.appended).toEqual([]);
  });

  it('re-arms the turn latch on every turn', async () => {
    const {session} = await newScriptedSession(scriptOf());
    const firstTurn = session.turnComplete;

    session.startTurn();

    expect(session.turnComplete).not.toBe(firstTurn);
  });
});
