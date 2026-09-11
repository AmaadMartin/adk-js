/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlmRequestProcessor,
  BasePlugin,
  BaseTool,
  Context,
  createEvent,
  Event,
  getLogger,
  InMemoryArtifactService,
  InMemorySessionService,
  InputValidationError,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  Logger,
  RunAsyncToolRequest,
  Runner,
  SequentialAgent,
  Session,
  setLogger,
  StreamingMode,
  Workflow,
} from '@google/adk';
import {FunctionDeclaration, Modality} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// The live driver is eval-system internal and deliberately absent from the
// public barrel, as `RequestIntercepterPlugin` is.
import {
  EvalLiveSession,
  isNormalClosure,
  LIVE_RUN_CONFIG,
  LIVE_SHUTDOWN_TIMEOUT_SECONDS,
  opensToolRound,
  requireLiveEvalRoot,
} from '../../src/evaluation/live_session.js';

import {FakeLiveLlm} from './test_helpers.js';

const APP_NAME = 'live_eval_app';
const USER_ID = 'live_eval_user';
const AGENT_NAME = 'live_agent';
const INSTRUCTION = 'Answer in one word.';
const MILLIS_PER_SECOND = 1000;

/** Captures the warnings the driver emits, in place of the ADK logger. */
class RecordingLogger implements Logger {
  readonly warnings: string[] = [];

  log(): void {}
  debug(): void {}
  info(): void {}
  error(): void {}
  setLogLevel(): void {}

  warn(...args: unknown[]): void {
    this.warnings.push(args.join(' '));
  }
}

class WeatherTool extends BaseTool {
  calls = 0;

  constructor() {
    super({name: 'get_weather', description: 'Get weather details.'});
  }

  override _getDeclaration(): FunctionDeclaration {
    return {name: this.name, description: this.description};
  }

  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    this.calls += 1;
    return {forecast: 'sunny', asked: request.args};
  }
}

/** Records every model callback the live driver replays. */
class RecordingPlugin extends BasePlugin {
  readonly beforeCalls: Array<{
    callbackContext: Context;
    llmRequest: LlmRequest;
  }> = [];
  readonly afterCalls: Array<{
    callbackContext: Context;
    llmResponse: LlmResponse;
  }> = [];

  /**
   * @param failForAgent Agent whose recording throws, so the driver's
   *     skip-and-warn path runs. Every other agent is recorded as usual.
   */
  constructor(private readonly failForAgent?: string) {
    super('recording_plugin');
  }

  override async beforeModelCallback(params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    if (params.callbackContext.agentName === this.failForAgent) {
      throw new Error(`cannot record ${this.failForAgent}`);
    }
    this.beforeCalls.push(params);
    return;
  }

  override async afterModelCallback(params: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse | undefined> {
    this.afterCalls.push(params);
    return;
  }
}

interface Harness {
  runner: Runner;
  session: Session;
  llm: FakeLiveLlm;
  plugin: RecordingPlugin;
  tool: WeatherTool;
}

interface HarnessOptions {
  withTool?: boolean;
  ignoreClose?: boolean;
  /** Omit the artifact service, as a runner built without one has none. */
  withoutArtifactService?: boolean;
  requestProcessors?: BaseLlmRequestProcessor[];
}

async function createHarness(
  script: Array<LlmResponse | Error>,
  options: HarnessOptions = {},
): Promise<Harness> {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
  });
  const llm = new FakeLiveLlm(options.ignoreClose);
  llm.connection.emit(...script);
  const tool = new WeatherTool();
  const agent = new LlmAgent({
    name: AGENT_NAME,
    model: llm,
    instruction: INSTRUCTION,
    tools: options.withTool ? [tool] : [],
    requestProcessors: options.requestProcessors,
  });
  const plugin = new RecordingPlugin();
  const runner = new Runner({
    appName: APP_NAME,
    agent,
    plugins: [plugin],
    sessionService,
    artifactService: options.withoutArtifactService
      ? undefined
      : new InMemoryArtifactService(),
  });
  return {runner, session, llm, plugin, tool};
}

/** Runs a session to completion and returns the events it queued. */
async function driveToCompletion(
  script: Array<LlmResponse | Error>,
  options: {withTool?: boolean} = {},
): Promise<{harness: Harness; liveSession: EvalLiveSession; events: Event[]}> {
  const harness = await createHarness(script, options);
  const liveSession = new EvalLiveSession(harness.runner, harness.session);
  liveSession.start();
  await liveSession.turnComplete;
  await liveSession.close();
  return {harness, liveSession, events: liveSession.eventQueue.drain()};
}

/**
 * A processor that yields a metadata event and allows no tool through, so the
 * driver's allowlist filter and its event drain are both exercised.
 */
class AllowNoToolsProcessor extends BaseLlmRequestProcessor {
  async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    llmRequest.allowedTools = [];
    yield createEvent({
      invocationId: invocationContext.invocationId,
      author: AGENT_NAME,
    });
  }
}

/** The tool declarations the recorded request carried. */
function declaredToolNames(harness: Harness): Array<string | undefined> {
  const call = harness.plugin.beforeCalls[0];
  if (call === undefined) {
    expect.fail('the driver fired no beforeModelCallback');
  }
  return (call.llmRequest.config?.tools ?? []).flatMap((tool) =>
    'functionDeclarations' in tool
      ? (tool.functionDeclarations ?? []).map((declaration) => declaration.name)
      : [],
  );
}

/**
 * A processor that turns server-side activity detection back on through the
 * run config it was handed, as a caller's own processor could.
 */
class DisableActivityDetectionProcessor extends BaseLlmRequestProcessor {
  async *runAsync(
    invocationContext: InvocationContext,
    _llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    const detection =
      invocationContext.runConfig?.realtimeInputConfig
        ?.automaticActivityDetection;
    if (detection) {
      detection.disabled = false;
    }
    yield createEvent({
      invocationId: invocationContext.invocationId,
      author: AGENT_NAME,
    });
  }
}

/** Reports whether the turn in flight has completed, without awaiting it. */
function watchTurn(liveSession: EvalLiveSession): () => boolean {
  let settled = false;
  void liveSession.turnComplete.then(() => {
    settled = true;
  });
  return () => settled;
}

/** Lets the driver work through everything the model has already sent. */
async function drainPendingWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

const TEXT_REPLY: LlmResponse = {
  content: {role: 'model', parts: [{text: 'sunny'}]},
};
const TURN_COMPLETE: LlmResponse = {turnComplete: true};

describe('LIVE_RUN_CONFIG', () => {
  it('runs bidirectional audio with both transcriptions on', () => {
    expect(LIVE_RUN_CONFIG.streamingMode).toBe(StreamingMode.BIDI);
    expect(LIVE_RUN_CONFIG.responseModalities).toEqual([Modality.AUDIO]);
    expect(LIVE_RUN_CONFIG.inputAudioTranscription).toEqual({});
    expect(LIVE_RUN_CONFIG.outputAudioTranscription).toEqual({});
  });

  it('disables server-side activity detection', () => {
    expect(
      LIVE_RUN_CONFIG.realtimeInputConfig?.automaticActivityDetection?.disabled,
    ).toBe(true);
  });

  it('is frozen against a direct write', () => {
    expect(Object.isFrozen(LIVE_RUN_CONFIG)).toBe(true);
  });

  it('survives a run that edits a nested field of its own config', async () => {
    const harness = await createHarness([TEXT_REPLY, TURN_COMPLETE], {
      requestProcessors: [new DisableActivityDetectionProcessor()],
    });
    const liveSession = new EvalLiveSession(harness.runner, harness.session);

    liveSession.start();
    await liveSession.turnComplete;
    await liveSession.close();

    // `Object.freeze` does not reach `realtimeInputConfig`, so a shallow copy
    // would have let the run turn detection back on for every later run.
    expect(
      LIVE_RUN_CONFIG.realtimeInputConfig?.automaticActivityDetection?.disabled,
    ).toBe(true);
  });

  it('survives a run unchanged', async () => {
    await driveToCompletion([TEXT_REPLY, TURN_COMPLETE]);

    expect(LIVE_RUN_CONFIG.streamingMode).toBe(StreamingMode.BIDI);
    expect(LIVE_RUN_CONFIG.responseModalities).toEqual([Modality.AUDIO]);
  });
});

describe('isNormalClosure', () => {
  it('accepts a closure reported as a code', () => {
    expect(isNormalClosure({code: 1000, message: 'OK'})).toBe(true);
  });

  it('accepts a closure reported as a status', () => {
    expect(isNormalClosure({status: 1000})).toBe(true);
  });

  it('rejects an abnormal closure', () => {
    expect(isNormalClosure({code: 1006})).toBe(false);
  });

  it('rejects a plain error', () => {
    expect(isNormalClosure(new Error('boom'))).toBe(false);
  });

  it('rejects a missing error', () => {
    expect(isNormalClosure(undefined)).toBe(false);
    expect(isNormalClosure(null)).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(isNormalClosure(1000)).toBe(false);
  });
});

describe('requireLiveEvalRoot', () => {
  it('returns an LlmAgent root unchanged', () => {
    const agent = new LlmAgent({name: AGENT_NAME});

    expect(requireLiveEvalRoot(agent)).toBe(agent);
  });

  it('returns a workflow root unchanged', () => {
    const workflow = new Workflow({
      name: 'eval_workflow',
      edges: [['START', new LlmAgent({name: 'node_agent'})]],
    });

    expect(requireLiveEvalRoot(workflow)).toBe(workflow);
  });

  it('refuses a root with no live path and names it', () => {
    const sequence = new SequentialAgent({
      name: 'eval_sequence',
      subAgents: [new LlmAgent({name: 'step_agent'})],
    });

    expect(() => requireLiveEvalRoot(sequence)).toThrow(InputValidationError);
    expect(() => requireLiveEvalRoot(sequence)).toThrow('eval_sequence');
  });
});

describe('EvalLiveSession', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses a root with no live path before anything is started', async () => {
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });
    const runner = new Runner({
      appName: APP_NAME,
      agent: new SequentialAgent({
        name: 'eval_sequence',
        subAgents: [new LlmAgent({name: 'step_agent'})],
      }),
      sessionService,
    });

    expect(() => new EvalLiveSession(runner, session)).toThrow(
      InputValidationError,
    );
  });

  it('fires beforeModelCallback once with the agent instruction', async () => {
    const {harness} = await driveToCompletion([TEXT_REPLY, TURN_COMPLETE]);

    expect(harness.plugin.beforeCalls).toHaveLength(1);
    const {callbackContext, llmRequest} = harness.plugin.beforeCalls[0];
    expect(callbackContext).toBeInstanceOf(Context);
    expect(JSON.stringify(llmRequest.config?.systemInstruction)).toContain(
      INSTRUCTION,
    );
  });

  it('records the tool declarations the agent was shown', async () => {
    const {harness} = await driveToCompletion([TEXT_REPLY, TURN_COMPLETE], {
      withTool: true,
    });

    expect(declaredToolNames(harness)).toEqual(['get_weather']);
  });

  it('leaves out a tool the request processors disallowed', async () => {
    const harness = await createHarness([TEXT_REPLY, TURN_COMPLETE], {
      withTool: true,
      requestProcessors: [new AllowNoToolsProcessor()],
    });
    const liveSession = new EvalLiveSession(harness.runner, harness.session);

    liveSession.start();
    await liveSession.turnComplete;
    await liveSession.close();

    expect(declaredToolNames(harness)).toEqual([]);
  });

  it('runs without an artifact service', async () => {
    const harness = await createHarness([TEXT_REPLY, TURN_COMPLETE], {
      withoutArtifactService: true,
    });
    const liveSession = new EvalLiveSession(harness.runner, harness.session);

    liveSession.start();
    await liveSession.turnComplete;
    await liveSession.close();

    expect(harness.plugin.beforeCalls).toHaveLength(1);
  });

  it('fires afterModelCallback once per event it saw', async () => {
    const {harness, events} = await driveToCompletion([
      TEXT_REPLY,
      TURN_COMPLETE,
    ]);

    expect(harness.plugin.afterCalls).toHaveLength(events.length);
    expect(harness.plugin.afterCalls.map((call) => call.llmResponse)).toEqual(
      events,
    );
  });

  it('stamps the turn id onto every event, over the connection id', async () => {
    const {liveSession, events} = await driveToCompletion([
      TEXT_REPLY,
      TURN_COMPLETE,
    ]);

    // The invocation context the flow runs under carries an id of its own, so
    // an unstamped event would not carry the turn's id.
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.invocationId).toBe(liveSession.currentInvocationId);
    }
  });

  it('offers only the non-partial events to the session service', async () => {
    const harness = await createHarness([
      {content: {role: 'model', parts: [{text: 'sun'}]}, partial: true},
      TEXT_REPLY,
      TURN_COMPLETE,
    ]);
    // `InMemorySessionService` drops a partial event itself, so the driver's
    // own guard is only visible in what it offers the service.
    const appended: Event[] = [];
    const originalAppend = harness.runner.sessionService.appendEvent.bind(
      harness.runner.sessionService,
    );
    vi.spyOn(harness.runner.sessionService, 'appendEvent').mockImplementation(
      async (request) => {
        appended.push(request.event);
        return originalAppend(request);
      },
    );
    const liveSession = new EvalLiveSession(harness.runner, harness.session);

    liveSession.start();
    await liveSession.turnComplete;
    await liveSession.close();

    const texts = appended.map((event) => event.content?.parts?.[0]?.text);
    expect(texts).toContain('sunny');
    expect(texts).not.toContain('sun');
  });

  it('keeps the turn open across a tool round', async () => {
    const harness = await createHarness(
      [
        {
          content: {
            role: 'model',
            parts: [{functionCall: {name: 'get_weather', args: {}}}],
          },
        },
        TURN_COMPLETE,
      ],
      {withTool: true},
    );
    const liveSession = new EvalLiveSession(harness.runner, harness.session);
    const settled = watchTurn(liveSession);

    liveSession.start();
    await drainPendingWork();

    // The model closed the tool round, not the turn: it still owes an answer.
    expect(settled()).toBe(false);
    harness.llm.connection.emit(TEXT_REPLY, TURN_COMPLETE);
    await liveSession.turnComplete;
    await liveSession.close();
    // The agent's own live flow runs the tool; the driver must not run it again.
    expect(harness.tool.calls).toBe(1);
  });

  it('ignores a turnComplete the user authored', async () => {
    const harness = await createHarness([
      {content: {role: 'user', parts: [{text: 'echo'}]}, turnComplete: true},
    ]);
    const liveSession = new EvalLiveSession(harness.runner, harness.session);
    const settled = watchTurn(liveSession);

    liveSession.start();
    await drainPendingWork();

    expect(settled()).toBe(false);
    harness.llm.connection.emit(TURN_COMPLETE);
    await liveSession.turnComplete;
    await liveSession.close();
    expect(settled()).toBe(true);
  });

  it('gives each turn a fresh id and a fresh promise', async () => {
    const harness = await createHarness([TURN_COMPLETE]);
    const liveSession = new EvalLiveSession(harness.runner, harness.session);
    const firstId = liveSession.currentInvocationId;
    const firstPromise = liveSession.turnComplete;

    liveSession.startTurn();

    expect(liveSession.currentInvocationId).not.toBe(firstId);
    expect(liveSession.turnComplete).not.toBe(firstPromise);
    liveSession.start();
    await liveSession.close();
  });

  it('reports it has finished once the driver stops', async () => {
    const harness = await createHarness([TURN_COMPLETE]);
    const liveSession = new EvalLiveSession(harness.runner, harness.session);
    expect(liveSession.isFinished).toBe(false);

    liveSession.start();
    await liveSession.close();

    expect(liveSession.isFinished).toBe(true);
  });

  it('releases a waiting turn when the driver stops without one', async () => {
    const harness = await createHarness([TEXT_REPLY]);
    const liveSession = new EvalLiveSession(harness.runner, harness.session);

    liveSession.start();
    await liveSession.close();

    await expect(liveSession.turnComplete).resolves.toBeUndefined();
  });

  it('opens an already-finished session on a turn that is over at once', async () => {
    const harness = await createHarness([]);
    const liveSession = new EvalLiveSession(harness.runner, harness.session);
    liveSession.start();
    harness.llm.connection.endStream();
    await drainPendingWork();

    liveSession.startTurn();

    // A fresh unresolved signal here would make the turn wait out its whole
    // timeout for a driver that has already stopped.
    await expect(liveSession.turnComplete).resolves.toBeUndefined();
    await liveSession.close();
  });

  it('keeps a driver failure handled while a turn is in flight', async () => {
    const harness = await createHarness([]);
    const liveSession = new EvalLiveSession(harness.runner, harness.session);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.prependListener('unhandledRejection', onUnhandled);

    try {
      liveSession.start();
      harness.llm.connection.emit(
        Object.assign(new Error('socket dropped'), {code: 1006}),
      );
      // Nobody awaits the driver here: the eval loop is waiting on the user
      // simulator. An unguarded rejection would terminate the process.
      await drainPendingWork();

      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }

    // The failure is still reported, rather than swallowed.
    await expect(liveSession.close()).rejects.toThrow('socket dropped');
  });

  it('refuses a second start', async () => {
    const harness = await createHarness([TURN_COMPLETE]);
    const liveSession = new EvalLiveSession(harness.runner, harness.session);

    liveSession.start();

    expect(() => liveSession.start()).toThrow(
      'Live session was already started.',
    );
    await liveSession.close();
  });

  it('refuses a close before a start', async () => {
    const harness = await createHarness([TURN_COMPLETE]);
    const liveSession = new EvalLiveSession(harness.runner, harness.session);

    await expect(liveSession.close()).rejects.toThrow(
      'Live session was exited before it was started.',
    );
  });

  it('tolerates a normal closure', async () => {
    const closure = Object.assign(new Error('closed'), {code: 1000});
    const harness = await createHarness([TEXT_REPLY, closure]);
    const liveSession = new EvalLiveSession(harness.runner, harness.session);

    liveSession.start();

    await expect(liveSession.close()).resolves.toBeUndefined();
  });

  it('reports an abnormal closure', async () => {
    const closure = Object.assign(new Error('dropped'), {code: 1006});
    const harness = await createHarness([closure]);
    const liveSession = new EvalLiveSession(harness.runner, harness.session);

    liveSession.start();

    await expect(liveSession.close()).rejects.toThrow('dropped');
  });

  it('abandons a driver that outlives the shutdown timeout', async () => {
    // The connection keeps its response stream open after `close()`, so the
    // driver never reaches the end of `runLive` on its own.
    const harness = await createHarness([TEXT_REPLY], {ignoreClose: true});
    const recordingLogger = new RecordingLogger();
    const previousLogger = getLogger();
    setLogger(recordingLogger);
    const liveSession = new EvalLiveSession(harness.runner, harness.session);
    liveSession.start();
    // Let the driver reach the receive loop before the clock is frozen.
    await new Promise((resolve) => setTimeout(resolve, 20));
    vi.useFakeTimers();

    try {
      const closing = liveSession.close();
      await vi.advanceTimersByTimeAsync(
        LIVE_SHUTDOWN_TIMEOUT_SECONDS * MILLIS_PER_SECOND + 1,
      );

      await expect(closing).resolves.toBeUndefined();
      expect(recordingLogger.warnings).toContain(
        'Timed out waiting for the live run to finish.',
      );
      expect(liveSession.isFinished).toBe(false);
    } finally {
      setLogger(previousLogger);
    }
  });
});

const NODE_AGENT_NAME = 'node_agent';

/** A model response carrying one function call. */
function callingResponse(...names: string[]): LlmResponse {
  return {
    content: {
      role: 'model',
      parts: names.map((name) => ({functionCall: {name, args: {}}})),
    },
  };
}

describe('opensToolRound', () => {
  const eventCalling = (...names: string[]): Event =>
    createEvent({
      author: NODE_AGENT_NAME,
      invocationId: 'inv',
      content: callingResponse(...names).content,
    });

  it.each(['finish_task', 'transfer_to_agent', 'task_completed'])(
    'reports that %s opens no tool round',
    (name) => {
      expect(opensToolRound(eventCalling(name))).toBe(false);
    },
  );

  it('reports that every turn-ending call together opens no tool round', () => {
    expect(
      opensToolRound(
        eventCalling('finish_task', 'transfer_to_agent', 'task_completed'),
      ),
    ).toBe(false);
  });

  it('reports that an ordinary call opens a tool round', () => {
    expect(opensToolRound(eventCalling('get_weather'))).toBe(true);
  });

  it('reports that an ordinary call alongside a handoff opens one', () => {
    expect(opensToolRound(eventCalling('finish_task', 'get_weather'))).toBe(
      true,
    );
  });

  it('reports that an event with no call opens none', () => {
    expect(opensToolRound(createEvent({author: NODE_AGENT_NAME}))).toBe(false);
  });

  it('treats a call with no name as an ordinary one', () => {
    const event = createEvent({
      author: NODE_AGENT_NAME,
      content: {role: 'model', parts: [{functionCall: {args: {}}}]},
    });

    // Nothing says it hands off, so the turn stays open for its answer.
    expect(opensToolRound(event)).toBe(true);
  });
});
