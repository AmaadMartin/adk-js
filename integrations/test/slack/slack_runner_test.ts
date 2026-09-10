/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  createEvent,
  InMemoryRunner,
  LlmAgent,
  LlmResponse,
  Logger,
  LogLevel,
  setLogger,
} from '@google/adk';
import {SlackRunner} from '@google/adk-integrations';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {FakeSlack, POSTED_TS} from './fake_slack.js';
import {modelEvent, ScriptedRunner} from './scripted_runner.js';

const USER_ID = 'U12345';
const CHANNEL_ID = 'C67890';
const MESSAGE_TS = '1234567890.123456';
const PARENT_TS = '1111111111.000001';

/** A logger that records the arguments of every `error` call. */
class RecordingLogger implements Logger {
  readonly errors: unknown[][] = [];

  log(): void {}

  debug(): void {}

  info(): void {}

  warn(): void {}

  error(...args: unknown[]): void {
    this.errors.push(args);
  }

  setLogLevel(_level: LogLevel): void {}
}

/** A model that answers with a fixed list of texts. */
class ScriptedLlm extends BaseLlm {
  constructor(private readonly replies: string[]) {
    super({model: 'scripted-model'});
  }

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    for (const text of this.replies) {
      yield {content: {role: 'model', parts: [{text}]}};
    }
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error('ScriptedLlm does not support live connections.');
  }
}

function appMention(overrides: Record<string, unknown> = {}) {
  return {
    type: 'app_mention',
    text: 'Hello bot',
    user: USER_ID,
    channel: CHANNEL_ID,
    ts: MESSAGE_TS,
    event_ts: MESSAGE_TS,
    ...overrides,
  };
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    type: 'message',
    text: 'Hello bot',
    user: USER_ID,
    channel: CHANNEL_ID,
    channel_type: 'channel',
    ts: MESSAGE_TS,
    event_ts: MESSAGE_TS,
    ...overrides,
  };
}

describe('SlackRunner', () => {
  let slack: FakeSlack;
  let runner: ScriptedRunner;
  let logger: RecordingLogger;

  beforeEach(async () => {
    logger = new RecordingLogger();
    setLogger(logger);
    slack = await FakeSlack.start();
    runner = new ScriptedRunner();
    runner.events = [modelEvent('Hi user!')];
    new SlackRunner({runner, slackApp: slack.boltApp});
  });

  afterEach(async () => {
    setLogger(null);
    await slack.stop();
  });

  describe('event filtering', () => {
    it('answers an app mention once', async () => {
      await slack.deliver(appMention());

      expect(runner.runCalls).toHaveLength(1);
      expect(slack.argsFor('chat.postMessage')).toHaveLength(1);
    });

    it('answers a direct message', async () => {
      await slack.deliver(message({channel_type: 'im'}));

      expect(runner.runCalls).toHaveLength(1);
    });

    it('answers a threaded channel reply', async () => {
      await slack.deliver(message({thread_ts: PARENT_TS}));

      expect(runner.runCalls).toHaveLength(1);
    });

    it('ignores a channel message that is not a threaded reply', async () => {
      await slack.deliver(message());

      expect(runner.runCalls).toEqual([]);
      expect(slack.calls).toEqual([]);
    });

    it('ignores a message posted by a bot id', async () => {
      await slack.deliver(message({channel_type: 'im', bot_id: 'B99999'}));

      expect(runner.runCalls).toEqual([]);
    });

    it('ignores a message carrying a bot profile', async () => {
      await slack.deliver(
        message({channel_type: 'im', bot_profile: {id: 'B99999'}}),
      );

      expect(runner.runCalls).toEqual([]);
    });

    it('ignores a message with a subtype', async () => {
      await slack.deliver(
        message({channel_type: 'im', subtype: 'bot_message'}),
      );

      expect(runner.runCalls).toEqual([]);
    });

    it('ignores an event with no text', async () => {
      await slack.deliver(appMention({text: ''}));

      expect(runner.runCalls).toEqual([]);
      expect(slack.calls).toEqual([]);
    });

    it('ignores an event with no user', async () => {
      await slack.deliver(appMention({user: undefined}));

      expect(runner.runCalls).toEqual([]);
      expect(slack.calls).toEqual([]);
    });
  });

  describe('session mapping', () => {
    it('keys the session on the channel and the thread', async () => {
      await slack.deliver(message({thread_ts: PARENT_TS}));

      expect(runner.runCalls[0].sessionId).toBe(`${CHANNEL_ID}-${PARENT_TS}`);
    });

    it('keys the session on the message timestamp outside a thread', async () => {
      await slack.deliver(appMention());

      expect(runner.runCalls[0].sessionId).toBe(`${CHANNEL_ID}-${MESSAGE_TS}`);
    });

    it('creates the session before the run, and reuses it', async () => {
      await slack.deliver(appMention());
      const created = await runner.sessionService.getSession({
        appName: 'slack_app',
        userId: USER_ID,
        sessionId: `${CHANNEL_ID}-${MESSAGE_TS}`,
      });
      expect(created).toBeDefined();

      await slack.deliver(appMention({thread_ts: MESSAGE_TS}));
      const {sessions} = await runner.sessionService.listSessions({
        appName: 'slack_app',
        userId: USER_ID,
      });

      expect(runner.runCalls).toHaveLength(2);
      expect(sessions).toHaveLength(1);
    });

    it('sends the message text to the agent as user content', async () => {
      await slack.deliver(appMention({text: 'What is the weather?'}));

      expect(runner.runCalls[0].newMessage).toMatchObject({
        role: 'user',
        parts: [{text: 'What is the weather?'}],
      });
    });
  });

  describe('replying', () => {
    it('deletes the placeholder when the run produced no text', async () => {
      runner.events = [modelEvent('')];

      await slack.deliver(appMention());

      expect(slack.argsFor('chat.update')).toEqual([]);
      expect(slack.argsFor('chat.delete')).toEqual([
        {channel: CHANNEL_ID, ts: POSTED_TS},
      ]);
    });

    it('skips an event that carries no content', async () => {
      runner.events = [createEvent({author: 'slack_agent'}), modelEvent('Hi!')];

      await slack.deliver(appMention());

      expect(slack.argsFor('chat.update')).toEqual([
        {channel: CHANNEL_ID, ts: POSTED_TS, text: 'Hi!'},
      ]);
    });

    it('skips an event whose content has no parts', async () => {
      runner.events = [
        createEvent({author: 'slack_agent', content: {role: 'model'}}),
        modelEvent('Hi!'),
      ];

      await slack.deliver(appMention());

      expect(slack.argsFor('chat.update')).toEqual([
        {channel: CHANNEL_ID, ts: POSTED_TS, text: 'Hi!'},
      ]);
    });

    it('deletes the placeholder when the run produced no event', async () => {
      runner.events = [];

      await slack.deliver(appMention());

      expect(slack.argsFor('chat.delete')).toEqual([
        {channel: CHANNEL_ID, ts: POSTED_TS},
      ]);
    });
  });

  describe('failure reporting', () => {
    it('logs the error', async () => {
      runner.failure = new Error('boom');

      await slack.deliver(appMention());

      expect(logger.errors).toEqual([
        ['Error running ADK agent for Slack:', runner.failure],
      ]);
    });

    it('replies in the thread when the placeholder was already consumed', async () => {
      runner.events = [modelEvent('Partial answer.')];
      runner.lateFailure = new Error('the stream broke');

      await slack.deliver(appMention());

      expect(slack.argsFor('chat.update')).toEqual([
        {channel: CHANNEL_ID, ts: POSTED_TS, text: 'Partial answer.'},
      ]);
      expect(slack.argsFor('chat.postMessage')[1]).toMatchObject({
        text: 'Sorry, I encountered an error: the stream broke',
        thread_ts: MESSAGE_TS,
      });
    });

    it('propagates the failure when the placeholder post fails', async () => {
      slack.failures.set('chat.postMessage', 'channel_not_found');

      await expect(slack.deliver(appMention())).rejects.toThrow(
        'channel_not_found',
      );

      // The placeholder post and the error report both went out and both
      // failed, so Bolt's listener error path sees the second rejection.
      expect(slack.argsFor('chat.postMessage')).toHaveLength(2);
      expect(slack.argsFor('chat.update')).toEqual([]);
    });

    it('stringifies a thrown value that is not an Error', async () => {
      runner.failure = 'plain failure';

      await slack.deliver(appMention());

      expect(slack.argsFor('chat.update')).toEqual([
        {
          channel: CHANNEL_ID,
          ts: POSTED_TS,
          text: 'Sorry, I encountered an error: plain failure',
        },
      ]);
    });
  });

  describe('start', () => {
    it('connects the app once, and rejects a second start', async () => {
      const slackRunner = new SlackRunner({runner, slackApp: slack.boltApp});

      await slackRunner.start();

      await expect(slackRunner.start()).rejects.toThrow(
        'SlackRunner is already started.',
      );
      expect(slack.connectCount).toBe(1);
    });
  });

  it('imports @slack/bolt for its types only, so the peer stays optional', () => {
    const source = readFileSync(
      fileURLToPath(
        new URL('../../src/slack/slack_runner.ts', import.meta.url),
      ),
      'utf8',
    );
    const boltImports = source
      .split('\n')
      .filter((line) => line.includes("from '@slack/bolt'"));

    expect(boltImports).toHaveLength(1);
    expect(boltImports[0].startsWith('import type ')).toBe(true);
  });
});

describe('SlackRunner with a real runner', () => {
  let slack: FakeSlack;

  beforeEach(async () => {
    slack = await FakeSlack.start();
  });

  afterEach(async () => {
    await slack.stop();
  });

  it('creates the session and answers with the agent output', async () => {
    const runner = new InMemoryRunner({
      appName: 'slack_app',
      agent: new LlmAgent({
        name: 'slack_agent',
        model: new ScriptedLlm(['Hi user!']),
      }),
    });
    new SlackRunner({runner, slackApp: slack.boltApp});

    await slack.deliver(appMention());

    expect(slack.argsFor('chat.update')).toEqual([
      {channel: CHANNEL_ID, ts: POSTED_TS, text: 'Hi user!'},
    ]);
    const session = await runner.sessionService.getSession({
      appName: 'slack_app',
      userId: USER_ID,
      sessionId: `${CHANNEL_ID}-${MESSAGE_TS}`,
    });
    expect(
      session?.events.map((event) => event.content?.parts?.[0]?.text),
    ).toEqual(['Hello bot', 'Hi user!']);
  });
});
