/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BasePlugin,
  BaseTool,
  Context,
  createEvent,
  Event,
  FunctionTool,
  InMemorySessionService,
  InvocationContext,
  LiveRequest,
  LiveRequestQueue,
  LlmAgent,
  LlmAgentConfig,
  LlmRequest,
  LlmResponse,
  RunConfig,
  Runner,
  RunnerConfig,
  SequentialAgent,
  Session,
  Workflow,
} from '@google/adk';
import {Modality, Part} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {BaseLlmRequestProcessor} from '../../src/agents/processors/base_llm_processor.js';
import {createRunConfig} from '../../src/agents/run_config.js';
import {
  CONSUME_TIMEOUT_MS,
  EvalLiveSession,
  isNormalLiveClosure,
  LIVE_RUN_CONFIG,
  LiveEventQueue,
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

/** An agent whose tool resolution fails, so recording its request throws. */
class UnlistableToolsAgent extends LlmAgent {
  override async canonicalTools(): Promise<BaseTool[]> {
    throw new Error(`cannot list the tools of ${this.name}`);
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

/** Replays a fixed event stream in place of `Runner.runLive`. */
class ScriptedLiveRunner extends Runner {
  /** The arguments `runLive` was called with, in call order. */
  readonly runLiveCalls: Array<{
    userId: string;
    sessionId: string;
    runConfig?: RunConfig;
    abortSignal?: AbortSignal;
  }> = [];

  constructor(
    config: RunnerConfig,
    private readonly script: () => AsyncGenerator<Event>,
  ) {
    super(config);
  }

  override async *runLive(params: {
    userId: string;
    sessionId: string;
    liveRequestQueue: LiveRequestQueue;
    runConfig?: RunConfig;
    abortSignal?: AbortSignal;
    liveSessionResumptionHandle?: string;
  }): AsyncGenerator<Event, void, undefined> {
    this.runLiveCalls.push({
      userId: params.userId,
      sessionId: params.sessionId,
      runConfig: params.runConfig,
      abortSignal: params.abortSignal,
    });
    yield* this.script();
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

/** Builds a session driven by a stubbed `Runner.runLive`. */
async function newNodeSession(params: {
  script: () => AsyncGenerator<Event>;
  root?: Workflow;
  plugins?: BasePlugin[];
}): Promise<{session: EvalLiveSession; runner: ScriptedLiveRunner}> {
  const sessionService = new InMemorySessionService();
  const session = await newSession(sessionService);
  const root =
    params.root ??
    new Workflow({
      name: 'stub_workflow',
      edges: [['START', new LlmAgent({name: 'greeter', model: stubModel()})]],
    });
  const runner = new ScriptedLiveRunner(
    {
      appName: APP_NAME,
      agent: root,
      sessionService,
      plugins: params.plugins,
    },
    params.script,
  );
  return {
    session: new EvalLiveSession(runner, session, USER_ID, session.id),
    runner,
  };
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

describe('LiveEventQueue', () => {
  it('returns what was pushed and empties itself', () => {
    const queue = new LiveEventQueue();
    const event = agentEvent({text: 'hi'});

    queue.push(event);

    expect(queue.drain()).toEqual([event]);
    expect(queue.drain()).toEqual([]);
  });
});

describe('EvalLiveSession node routing', () => {
  it('drives a workflow root through Runner.runLive', async () => {
    const event = agentEvent({text: 'Hi', turnComplete: true});
    const {session, runner} = await newNodeSession({script: scriptOf(event)});

    await session.consumeEvents();

    expect(runner.runLiveCalls).toHaveLength(1);
    expect(runner.runLiveCalls[0].userId).toBe(USER_ID);
    expect(runner.runLiveCalls[0].runConfig).toBe(LIVE_RUN_CONFIG);
    const queued = session.eventQueue.drain();
    expect(queued).toHaveLength(1);
    expect(queued[0].invocationId).toBe(session.currentInvocationId);
    expect(session.isFinished).toBe(true);
    await expect(session.turnComplete).resolves.toBeUndefined();
  });

  it('passes the session the harness owns to Runner.runLive', async () => {
    const {session, runner} = await newNodeSession({
      script: scriptOf(agentEvent({text: 'Hi', turnComplete: true})),
    });

    await session.consumeEvents();

    expect(runner.runLiveCalls[0].sessionId).not.toBe('');
    expect(runner.runLiveCalls[0].userId).toBe(USER_ID);
  });

  it('swallows the turn complete that accompanies a tool call', async () => {
    const {session} = await newNodeSession({
      script: scriptOf(
        agentEvent({
          author: 'dob_verifier_agent',
          functionCall: {name: 'validate_date_of_birth'},
        }),
        agentEvent({author: 'dob_verifier_agent', turnComplete: true}),
      ),
    });

    await session.consumeNodeEvents();

    await expect(
      Promise.race([session.turnComplete, Promise.resolve('pending')]),
    ).resolves.toBe('pending');
  });

  it('releases the latch on the real turn complete after a tool call', async () => {
    const {session} = await newNodeSession({
      script: scriptOf(
        agentEvent({
          author: 'dob_verifier_agent',
          functionCall: {name: 'validate_date_of_birth'},
        }),
        agentEvent({author: 'dob_verifier_agent', turnComplete: true}),
        agentEvent({
          author: 'dob_verifier_agent',
          text: 'Your identity is verified.',
          turnComplete: true,
        }),
      ),
    });

    await session.consumeNodeEvents();

    await expect(session.turnComplete).resolves.toBeUndefined();
  });

  it.each(['finish_task', 'transfer_to_agent', 'task_completed'])(
    'lets the next agent turn through after a %s call',
    async (functionName) => {
      const {session} = await newNodeSession({
        script: scriptOf(
          agentEvent({
            author: 'greeter_agent',
            functionCall: {name: functionName},
          }),
          agentEvent({
            author: 'dob_verifier_agent',
            text: 'What is your date of birth?',
            turnComplete: true,
          }),
        ),
      });

      await session.consumeNodeEvents();

      await expect(session.turnComplete).resolves.toBeUndefined();
    },
  );

  it('ignores a turn complete the user authored', async () => {
    const {session} = await newNodeSession({
      script: scriptOf(agentEvent({author: 'user', turnComplete: true})),
    });

    await session.consumeNodeEvents();

    await expect(
      Promise.race([session.turnComplete, Promise.resolve('pending')]),
    ).resolves.toBe('pending');
  });

  it.each(['code', 'status', 'closeCode'] as const)(
    'tolerates a normal closure reported as `%s`',
    async (field) => {
      const {session} = await newNodeSession({
        script: failingScript(closureError(field, 1000)),
      });

      await expect(session.consumeEvents()).resolves.toBeUndefined();
      // The transcript collected before the close is kept.
      expect(session.eventQueue.drain()).toHaveLength(1);
      expect(session.isFinished).toBe(true);
      await expect(session.turnComplete).resolves.toBeUndefined();
    },
  );

  it.each(['code', 'status', 'closeCode'] as const)(
    'propagates an abnormal closure reported as `%s`',
    async (field) => {
      const {session} = await newNodeSession({
        script: failingScript(closureError(field, 1011)),
      });

      await expect(session.consumeEvents()).rejects.toThrow('closed with 1011');
      // The teardown still runs, so no turn waiter is stranded.
      expect(session.isFinished).toBe(true);
      await expect(session.turnComplete).resolves.toBeUndefined();
    },
  );

  it('fires afterModelCallback only for the authors it recorded', async () => {
    const plugin = new CallbackRecorderPlugin('callback_recorder');
    const greeter = new LlmAgent({name: 'greeter', model: stubModel()});
    const greeterEvent = agentEvent({author: 'greeter', text: 'Hello'});
    const strangerEvent = agentEvent({author: 'unrecorded_agent', text: 'Hi'});
    const {session} = await newNodeSession({
      script: scriptOf(greeterEvent, strangerEvent),
      root: new Workflow({name: 'wf', edges: [['START', greeter]]}),
      plugins: [plugin],
    });

    await session.consumeNodeEvents();

    expect(plugin.afterModelCalls).toHaveLength(1);
    expect(plugin.afterModelCalls[0].llmResponse).toBe(greeterEvent);
  });
});

describe('EvalLiveSession.recordNodeAppDetails', () => {
  it('records every agent of the graph', async () => {
    const greeter = new LlmAgent({name: 'greeter', model: stubModel()});
    const verifier = new LlmAgent({name: 'verifier', model: stubModel()});
    const {session} = await newNodeSession({
      script: scriptOf(),
      root: new Workflow({
        name: 'wf',
        edges: [
          ['START', greeter],
          [greeter, verifier],
        ],
      }),
    });

    const recorded = await session.recordNodeAppDetails();

    expect([...recorded.keys()]).toEqual(['greeter', 'verifier']);
  });

  it('records nothing when the root holds no graph', async () => {
    const {session} = await newAgentSession({
      agent: new LlmAgent({name: 'solo', model: stubModel()}),
    });

    expect(await session.recordNodeAppDetails()).toEqual(new Map());
  });

  it('skips an agent it cannot record and keeps the healthy one', async () => {
    const bad = new UnlistableToolsAgent({name: 'bad', model: stubModel()});
    const good = new LlmAgent({name: 'good', model: stubModel()});
    const {session} = await newNodeSession({
      script: scriptOf(),
      root: new Workflow({
        name: 'wf',
        edges: [
          ['START', bad],
          [bad, good],
        ],
      }),
    });

    const recorded = await session.recordNodeAppDetails();

    expect([...recorded.keys()]).toEqual(['good']);
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

    const queued = session.eventQueue.drain();
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
    expect(session.eventQueue.drain()).toHaveLength(1);
    expect(plugin.beforeModelCalls[0].llmRequest.config?.tools).toBeUndefined();
  });

  it('arms the tool-call guard for a call the model left unnamed', async () => {
    const {session} = await newNodeSession({
      script: scriptOf(
        createEvent({
          author: 'agent',
          invocationId: 'stream_invocation',
          content: {parts: [{functionCall: {}}]},
        }),
        agentEvent({turnComplete: true}),
      ),
    });

    await session.consumeNodeEvents();

    await expect(
      Promise.race([session.turnComplete, Promise.resolve('pending')]),
    ).resolves.toBe('pending');
  });

  it('replays no callback for an event that names no author', async () => {
    const plugin = new CallbackRecorderPlugin('callback_recorder');
    const greeter = new LlmAgent({name: 'greeter', model: stubModel()});
    const {session} = await newNodeSession({
      script: scriptOf(createEvent({invocationId: 'stream_invocation'})),
      root: new Workflow({name: 'wf', edges: [['START', greeter]]}),
      plugins: [plugin],
    });

    await session.consumeNodeEvents();

    expect(plugin.afterModelCalls).toHaveLength(0);
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

describe('EvalLiveSession lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses to close a session that was never started', async () => {
    const {session} = await newNodeSession({script: scriptOf()});

    await expect(session.close()).rejects.toThrow(
      'closed before it was started',
    );
  });

  it('starts one consumer however often start is called', async () => {
    const {session, runner} = await newNodeSession({
      script: scriptOf(agentEvent({text: 'Hi', turnComplete: true})),
    });

    session.start();
    session.start();
    await session.close();

    expect(runner.runLiveCalls).toHaveLength(1);
  });

  it('closes the request queue and waits for the consumer', async () => {
    const {session} = await newNodeSession({
      script: scriptOf(agentEvent({text: 'Hi', turnComplete: true})),
    });

    session.start();
    await session.close();

    expect(session.isFinished).toBe(true);
    expect(() => session.liveRequestQueue.sendContent({parts: []})).toThrow();
  });

  it('swallows a normal closure the consumer failed with', async () => {
    const {session} = await newNodeSession({
      script: failingScript(closureError('code', 1000)),
    });

    session.start();

    await expect(session.close()).resolves.toBeUndefined();
  });

  it('propagates an abnormal closure the consumer failed with', async () => {
    const {session} = await newNodeSession({
      script: failingScript(closureError('code', 1011)),
    });

    session.start();

    await expect(session.close()).rejects.toThrow('closed with 1011');
  });

  it('aborts a consumer that outlives the close timeout', async () => {
    vi.useFakeTimers();
    let releaseConsumer: (() => void) | undefined;
    const stalled = new Promise<void>((resolve) => {
      releaseConsumer = resolve;
    });
    const {session, runner} = await newNodeSession({
      script: async function* () {
        await stalled;
        yield agentEvent({text: 'late', turnComplete: true});
      },
    });

    session.start();
    const closing = session.close();
    await vi.advanceTimersByTimeAsync(CONSUME_TIMEOUT_MS);

    await expect(closing).resolves.toBeUndefined();
    expect(session.isFinished).toBe(false);
    expect(runner.runLiveCalls[0].abortSignal?.aborted).toBe(true);
    releaseConsumer?.();
  });

  it('swallows a normal closure the agent driver raised', async () => {
    const agent = new ScriptedLiveAgent(
      {name: 'test_agent', model: stubModel()},
      failingScript(closureError('code', 1000)),
    );
    const {session} = await newAgentSession({agent});

    session.start();

    await expect(session.close()).resolves.toBeUndefined();
  });

  it('re-arms the turn latch on every turn', async () => {
    const {session} = await newNodeSession({script: scriptOf()});
    const firstTurn = session.turnComplete;

    session.startTurn();

    expect(session.turnComplete).not.toBe(firstTurn);
  });
});
