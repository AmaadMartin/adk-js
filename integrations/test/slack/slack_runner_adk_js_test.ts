/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Cases the adk-python suite does not cover: the listener guards, the session
// key, the empty-run path and the lifecycle methods.

import {Event, InMemorySessionService, LlmAgent, Runner} from '@google/adk';
import {SlackRunner} from '@google/adk-integrations';
import {App} from '@slack/bolt';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {handleSlackMessage} from '../../src/slack/slack_runner.js';
import {
  AGENT_NAME,
  APP_NAME,
  CHANNEL,
  createSlackFixture,
  emptyEvent,
  EVENT_TS,
  FakeSlackApi,
  modelEvent,
  nonTextEvent,
  startFakeSlackApi,
  streamOf,
  THINKING_TS,
  USER,
} from './slack_fixture.js';

const {receiverCalls, FakeSocketModeReceiver} = vi.hoisted(() => {
  const calls: string[] = [];
  class Fake {
    constructor(readonly options: {appToken: string}) {
      calls.push(`construct:${options.appToken}`);
    }
    init(): void {
      calls.push('init');
    }
    async start(): Promise<void> {
      calls.push('start');
    }
    async stop(): Promise<void> {
      calls.push('stop');
    }
  }
  return {receiverCalls: calls, FakeSocketModeReceiver: Fake};
});

// SocketModeReceiver.start() opens a WebSocket to Slack, so the lifecycle
// tests swap it for a recorder. Everything else stays the real Bolt module.
vi.mock('@slack/bolt', async (importActual) => {
  const actual = await importActual<typeof import('@slack/bolt')>();
  return {...actual, SocketModeReceiver: FakeSocketModeReceiver};
});

describe('handleSlackMessage', () => {
  let fixture: ReturnType<typeof createSlackFixture>;

  beforeEach(() => {
    fixture = createSlackFixture();
  });

  /** Asserts the handler made no Slack call and never started a run. */
  function expectSilent(): void {
    const {say, update, remove, runAsync} = fixture;
    expect(say).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(runAsync).not.toHaveBeenCalled();
  }

  it.each([
    ['text is missing', {user: USER, channel: CHANNEL, ts: EVENT_TS}],
    ['text is empty', {text: '', user: USER, channel: CHANNEL, ts: EVENT_TS}],
    ['user is missing', {text: 'hi', channel: CHANNEL, ts: EVENT_TS}],
    ['channel is missing', {text: 'hi', user: USER, ts: EVENT_TS}],
  ])('makes no Slack call when %s', async (_name, event) => {
    const {runner, client, say} = fixture;

    await handleSlackMessage({runner, client, event, say});

    expectSilent();
  });

  it('keys the session on the channel and the thread timestamp', async () => {
    const {runner, client, say, runAsync} = fixture;
    runAsync.mockImplementation(streamOf([modelEvent('ok')]));

    await handleSlackMessage({
      runner,
      client,
      event: {
        text: 'hi',
        user: USER,
        channel: CHANNEL,
        ts: EVENT_TS,
        thread_ts: '999.111',
      },
      say,
    });

    expect(runAsync).toHaveBeenCalledWith(
      expect.objectContaining({userId: USER, sessionId: `${CHANNEL}-999.111`}),
    );
  });

  it('falls back to the message timestamp when there is no thread', async () => {
    const {runner, client, say, runAsync} = fixture;
    runAsync.mockImplementation(streamOf([modelEvent('ok')]));

    await handleSlackMessage({
      runner,
      client,
      event: {text: 'hi', user: USER, channel: CHANNEL, ts: EVENT_TS},
      say,
    });

    expect(runAsync).toHaveBeenCalledWith(
      expect.objectContaining({sessionId: `${CHANNEL}-${EVENT_TS}`}),
    );
  });

  it('falls back to the message timestamp when thread_ts is empty', async () => {
    const {runner, client, say, runAsync} = fixture;
    runAsync.mockImplementation(streamOf([modelEvent('ok')]));

    await handleSlackMessage({
      runner,
      client,
      event: {
        text: 'hi',
        user: USER,
        channel: CHANNEL,
        ts: EVENT_TS,
        thread_ts: '',
      },
      say,
    });

    expect(runAsync).toHaveBeenCalledWith(
      expect.objectContaining({sessionId: `${CHANNEL}-${EVENT_TS}`}),
    );
  });

  it('keys the session on the channel alone when no timestamp is present', async () => {
    const {runner, client, say, runAsync} = fixture;
    runAsync.mockImplementation(streamOf([modelEvent('ok')]));

    await handleSlackMessage({
      runner,
      client,
      event: {text: 'hi', user: USER, channel: CHANNEL},
      say,
    });

    expect(runAsync).toHaveBeenCalledWith(
      expect.objectContaining({sessionId: CHANNEL}),
    );
    expect(say).toHaveBeenCalledWith({
      text: '_Thinking..._',
      thread_ts: undefined,
    });
  });

  it('deletes the placeholder when the run produces no text', async () => {
    const {runner, client, say, update, remove} = fixture;
    fixture.runAsync.mockImplementation(streamOf([]));

    await handleSlackMessage({
      runner,
      client,
      event: {text: 'hi', user: USER, channel: CHANNEL, ts: EVENT_TS},
      say,
    });

    expect(update).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith({channel: CHANNEL, ts: THINKING_TS});
  });

  it('deletes the placeholder when no event carries a text part', async () => {
    const {runner, client, say, update, remove} = fixture;
    fixture.runAsync.mockImplementation(
      streamOf([emptyEvent(), nonTextEvent()]),
    );

    await handleSlackMessage({
      runner,
      client,
      event: {text: 'hi', user: USER, channel: CHANNEL, ts: EVENT_TS},
      say,
    });

    expect(say).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith({channel: CHANNEL, ts: THINKING_TS});
  });

  it('reports an error through say once the placeholder is consumed', async () => {
    const {runner, client, say, update, remove} = fixture;
    fixture.runAsync.mockImplementation(
      async function* partialThenFail(): AsyncGenerator<Event, void, void> {
        yield* streamOf([modelEvent('First thing.')])();
        throw new Error('Something went wrong');
      },
    );

    await handleSlackMessage({
      runner,
      client,
      event: {text: 'hi', user: USER, channel: CHANNEL, ts: EVENT_TS},
      say,
    });

    // The first part already used chat.update, so the error must go out as a
    // new message rather than overwriting the answer.
    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith({
      channel: CHANNEL,
      ts: THINKING_TS,
      text: 'First thing.',
    });
    expect(say).toHaveBeenCalledTimes(2);
    expect(say).toHaveBeenLastCalledWith({
      text: 'Sorry, I encountered an error: Something went wrong',
      thread_ts: EVENT_TS,
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it('reports an error through say when the placeholder was never posted', async () => {
    const {runner, client, update} = fixture;
    const say = vi
      .fn(async () => ({ok: true, ts: THINKING_TS}))
      .mockRejectedValueOnce(new Error('rate limited'));

    await handleSlackMessage({
      runner,
      client,
      event: {text: 'hi', user: USER, channel: CHANNEL, ts: EVENT_TS},
      say,
    });

    // The placeholder never went out, so there is no message to update.
    expect(update).not.toHaveBeenCalled();
    expect(say).toHaveBeenLastCalledWith({
      text: 'Sorry, I encountered an error: rate limited',
      thread_ts: EVENT_TS,
    });
  });

  it('reports a thrown value that is not an Error', async () => {
    const {runner, client, say, update} = fixture;
    // A rejected promise can carry anything; the reference formats it with
    // str(e), so a non-Error must still reach the user.
    fixture.runAsync.mockImplementation(streamOf('channel_not_found'));

    await handleSlackMessage({
      runner,
      client,
      event: {text: 'hi', user: USER, channel: CHANNEL, ts: EVENT_TS},
      say,
    });

    expect(update).toHaveBeenCalledWith({
      channel: CHANNEL,
      ts: THINKING_TS,
      text: 'Sorry, I encountered an error: channel_not_found',
    });
  });

  it('propagates a failure to report the error', async () => {
    const {runner, client} = fixture;
    const say = vi.fn(async () => {
      throw new Error('rate limited');
    });

    // Matching adk-python, the handler does not catch its own error report;
    // Bolt's global error handler takes it from here.
    await expect(
      handleSlackMessage({
        runner,
        client,
        event: {text: 'hi', user: USER, channel: CHANNEL, ts: EVENT_TS},
        say,
      }),
    ).rejects.toThrow('rate limited');
    expect(say).toHaveBeenCalledTimes(2);
  });
});

/** An agent that answers with fixed text, so no model is contacted. */
class ScriptedAgent extends LlmAgent {
  constructor(private readonly replies: string[]) {
    super({name: AGENT_NAME, model: 'gemini-2.5-flash'});
  }

  protected override async *runAsyncImpl() {
    for (const text of this.replies) {
      yield modelEvent(text);
    }
  }
}

describe('SlackRunner listeners', () => {
  let slackApi: FakeSlackApi;
  let slackApp: App;
  let sessionService: InMemorySessionService;

  beforeEach(async () => {
    slackApi = await startFakeSlackApi();
    slackApp = new App({
      token: 'test-bot-token',
      signingSecret: 'test-signing-secret',
      tokenVerificationEnabled: false,
      botId: 'B00000000',
      botUserId: 'U00000000',
      clientOptions: {slackApiUrl: slackApi.url},
    });
    sessionService = new InMemorySessionService();
  });

  afterEach(async () => {
    await slackApi.close();
  });

  /** Registers a SlackRunner whose agent answers with `replies`. */
  function mount(replies: string[] = ['Hi user!']): void {
    const runner = new Runner({
      appName: APP_NAME,
      agent: new ScriptedAgent(replies),
      sessionService,
    });
    new SlackRunner({runner, slackApp});
  }

  /** Feeds one Slack event through Bolt's real dispatch. */
  async function dispatch(event: Record<string, unknown>): Promise<void> {
    await slackApp.processEvent({
      body: {
        type: 'event_callback',
        team_id: 'T00000000',
        api_app_id: 'A00000000',
        event,
        event_id: 'Ev00000000',
        event_time: 1,
      },
      ack: async () => {},
    });
  }

  const message = (
    extra: Record<string, unknown>,
  ): Record<string, unknown> => ({
    type: 'message',
    text: 'Hello bot',
    user: USER,
    channel: CHANNEL,
    ts: EVENT_TS,
    ...extra,
  });

  it.each<[string, {channel_type: string; thread_ts?: string}]>([
    ['a direct message', {channel_type: 'im'}],
    ['a threaded reply', {channel_type: 'channel', thread_ts: '999.111'}],
  ])('answers %s', async (_name, extra) => {
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER,
      sessionId: `${CHANNEL}-${extra.thread_ts ?? EVENT_TS}`,
    });
    mount();

    await dispatch(message(extra));

    expect(slackApi.calls.map((call) => call.method)).toEqual([
      'chat.postMessage',
      'chat.update',
    ]);
    expect(slackApi.calls[1].params).toMatchObject({
      channel: CHANNEL,
      ts: THINKING_TS,
      text: 'Hi user!',
    });
  });

  it('answers an app mention that is neither a direct message nor threaded', async () => {
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER,
      sessionId: `${CHANNEL}-${EVENT_TS}`,
    });
    mount();

    await dispatch({
      type: 'app_mention',
      text: '<@U00000000> Hello bot',
      user: USER,
      channel: CHANNEL,
      ts: EVENT_TS,
    });

    expect(slackApi.calls.map((call) => call.method)).toEqual([
      'chat.postMessage',
      'chat.update',
    ]);
  });

  it.each([
    ['the message came from a bot id', {channel_type: 'im', bot_id: 'B123'}],
    [
      'the message came from a bot profile',
      {channel_type: 'im', bot_profile: {id: 'B123'}},
    ],
    ['the message is neither a direct message nor threaded', {}],
  ])('ignores a message when %s', async (_name, extra) => {
    mount();

    await dispatch(message(extra));

    expect(slackApi.calls).toEqual([]);
  });

  it('posts every reply after the first as a new threaded message', async () => {
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER,
      sessionId: `${CHANNEL}-${EVENT_TS}`,
    });
    mount(['First thing.', 'Second thing.']);

    await dispatch(message({channel_type: 'im'}));

    expect(slackApi.calls.map((call) => call.method)).toEqual([
      'chat.postMessage',
      'chat.update',
      'chat.postMessage',
    ]);
    expect(slackApi.calls[2].params).toMatchObject({
      text: 'Second thing.',
      thread_ts: EVENT_TS,
    });
  });

  it('tells the user when the session does not exist', async () => {
    mount();

    await dispatch(message({channel_type: 'im'}));

    expect(slackApi.calls.map((call) => call.method)).toEqual([
      'chat.postMessage',
      'chat.update',
    ]);
    expect(slackApi.calls[1].params.text).toContain(
      'Sorry, I encountered an error',
    );
  });
});

describe('SlackRunner lifecycle', () => {
  let slackRunner: SlackRunner;

  beforeEach(() => {
    receiverCalls.length = 0;
    slackRunner = new SlackRunner({
      runner: new Runner({
        appName: APP_NAME,
        agent: new LlmAgent({name: AGENT_NAME, model: 'gemini-2.5-flash'}),
        sessionService: new InMemorySessionService(),
      }),
      slackApp: new App({
        token: 'test-bot-token',
        signingSecret: 'test-signing-secret',
        tokenVerificationEnabled: false,
        botId: 'B00000000',
        botUserId: 'U00000000',
      }),
    });
  });

  it('opens the socket with the app token', async () => {
    await slackRunner.start('test-app-token');

    expect(receiverCalls).toEqual([
      'construct:test-app-token',
      'init',
      'start',
    ]);
  });

  it('rejects a second start', async () => {
    await slackRunner.start('test-app-token');

    await expect(slackRunner.start('test-app-token')).rejects.toThrow(
      'SlackRunner is already started.',
    );
    expect(receiverCalls.filter((call) => call === 'start')).toHaveLength(1);
  });

  it('does nothing when stopped before it is started', async () => {
    await slackRunner.stop();

    expect(receiverCalls).toEqual([]);
  });

  it('allows a restart after stop', async () => {
    await slackRunner.start('test-app-token');
    await slackRunner.stop();
    await slackRunner.start('test-second-token');

    expect(receiverCalls).toEqual([
      'construct:test-app-token',
      'init',
      'start',
      'stop',
      'construct:test-second-token',
      'init',
      'start',
    ]);
  });
});
