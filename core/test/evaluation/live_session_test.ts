/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BasePlugin,
  BaseTool,
  Context,
  EvalLiveSession,
  Event,
  getLogger,
  InMemoryArtifactService,
  InMemorySessionService,
  InputValidationError,
  isNormalClosure,
  LIVE_RUN_CONFIG,
  LIVE_SHUTDOWN_TIMEOUT_SECONDS,
  LiveEventQueue,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  Logger,
  requireLiveEvalAgent,
  RunAsyncToolRequest,
  Runner,
  Session,
  setLogger,
  StreamingMode,
  Workflow,
} from '@google/adk';
import {FunctionDeclaration, Modality} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {ScriptedLiveLlm} from './test_helpers.js';

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

  constructor() {
    super('recording_plugin');
  }

  override async beforeModelCallback(params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
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
  llm: ScriptedLiveLlm;
  plugin: RecordingPlugin;
  tool: WeatherTool;
}

async function createHarness(
  script: Array<LlmResponse | Error>,
  options: {withTool?: boolean; ignoreClose?: boolean} = {},
): Promise<Harness> {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
  });
  const llm = new ScriptedLiveLlm(script, options.ignoreClose);
  const tool = new WeatherTool();
  const agent = new LlmAgent({
    name: AGENT_NAME,
    model: llm,
    instruction: INSTRUCTION,
    tools: options.withTool ? [tool] : [],
  });
  const plugin = new RecordingPlugin();
  const runner = new Runner({
    appName: APP_NAME,
    agent,
    plugins: [plugin],
    sessionService,
    artifactService: new InMemoryArtifactService(),
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

  it('is frozen, so one run cannot reconfigure the next', () => {
    expect(Object.isFrozen(LIVE_RUN_CONFIG)).toBe(true);
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

describe('requireLiveEvalAgent', () => {
  it('returns an LlmAgent root unchanged', () => {
    const agent = new LlmAgent({name: AGENT_NAME});

    expect(requireLiveEvalAgent(agent)).toBe(agent);
  });

  it('refuses a workflow root and names it', () => {
    const workflow = new Workflow({
      name: 'eval_workflow',
      edges: [['START', new LlmAgent({name: 'node_agent'})]],
    });

    expect(() => requireLiveEvalAgent(workflow)).toThrow(InputValidationError);
    expect(() => requireLiveEvalAgent(workflow)).toThrow('eval_workflow');
  });
});

describe('LiveEventQueue', () => {
  it('hands over everything queued and empties itself', () => {
    const queue = new LiveEventQueue();
    const event = {invocationId: 'inv-1'} as Event;

    queue.push(event);

    expect(queue.drain()).toEqual([event]);
    expect(queue.drain()).toEqual([]);
  });
});

describe('EvalLiveSession', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses a workflow root before anything is started', async () => {
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });
    const runner = new Runner({
      appName: APP_NAME,
      agent: new Workflow({
        name: 'eval_workflow',
        edges: [['START', new LlmAgent({name: 'node_agent'})]],
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

    const tools = harness.plugin.beforeCalls[0].llmRequest.config?.tools ?? [];
    const declarations = tools.flatMap((tool) =>
      'functionDeclarations' in tool ? (tool.functionDeclarations ?? []) : [],
    );
    expect(declarations.map((declaration) => declaration.name)).toEqual([
      'get_weather',
    ]);
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

  it('stamps the current invocation id onto every event', async () => {
    const {liveSession, events} = await driveToCompletion([
      TEXT_REPLY,
      TURN_COMPLETE,
    ]);

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.invocationId).toBe(liveSession.currentInvocationId);
    }
  });

  it('appends the non-partial events to the session and skips partials', async () => {
    const {harness} = await driveToCompletion([
      {content: {role: 'model', parts: [{text: 'sun'}]}, partial: true},
      TEXT_REPLY,
      TURN_COMPLETE,
    ]);

    const stored = await harness.runner.sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: harness.session.id,
    });
    const texts = (stored?.events ?? []).map(
      (event) => event.content?.parts?.[0]?.text,
    );
    expect(texts).toContain('sunny');
    expect(texts).not.toContain('sun');
  });

  it('keeps the turn open across a tool round', async () => {
    const {harness, events} = await driveToCompletion(
      [
        {
          content: {
            role: 'model',
            parts: [{functionCall: {name: 'get_weather', args: {}}}],
          },
        },
        TURN_COMPLETE,
        TEXT_REPLY,
        TURN_COMPLETE,
      ],
      {withTool: true},
    );

    // The turn resolved on the second `turnComplete`, so the reply that
    // followed the tool round is part of the same turn.
    const texts = events.map((event) => event.content?.parts?.[0]?.text);
    expect(texts).toContain('sunny');
    // The agent's own live flow runs the tool; the driver must not run it again.
    expect(harness.tool.calls).toBe(1);
  });

  it('ignores a turnComplete the user authored', async () => {
    const harness = await createHarness([
      {content: {role: 'user', parts: [{text: 'echo'}]}, turnComplete: true},
      TEXT_REPLY,
      TURN_COMPLETE,
    ]);
    const liveSession = new EvalLiveSession(harness.runner, harness.session);

    liveSession.start();
    await liveSession.turnComplete;
    await liveSession.close();

    // Had the user-authored event resolved the turn, the model reply queued
    // after it would still be in flight.
    const texts = liveSession.eventQueue
      .drain()
      .map((event) => event.content?.parts?.[0]?.text);
    expect(texts).toContain('sunny');
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
