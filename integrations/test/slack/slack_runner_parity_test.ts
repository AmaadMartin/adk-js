/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reference tests ported from adk-python
 * `tests/unittests/integrations/slack/test_slack_runner.py` at `main`
 * `c7ef8cfa8269738033180f49338f160254b8b137`.
 *
 * Every `it()` keeps its Python function name so a reviewer can grep for the
 * original. Python drives the private `_handle_message` with a mocked `say`;
 * these drive Bolt's own dispatch instead, so `say` is the real one and its
 * `chat.postMessage` call is what the assertions read.
 */

import {LogLevel, setLogger} from '@google/adk';
import {SlackRunner} from '@google/adk-integrations';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {FakeSlack, POSTED_TS} from './fake_slack.js';
import {modelEvent, ScriptedRunner} from './scripted_runner.js';

const USER_ID = 'U12345';
const CHANNEL_ID = 'C67890';
const MESSAGE_TS = '1234567890.123456';

describe('SlackRunner parity', () => {
  let slack: FakeSlack;
  let runner: ScriptedRunner;

  beforeEach(async () => {
    // The error test logs through the ADK logger; keep it out of the report.
    setLogger({
      log: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      setLogLevel: (_level: LogLevel) => {},
    });
    slack = await FakeSlack.start();
    runner = new ScriptedRunner();
    new SlackRunner({runner, slackApp: slack.boltApp});
  });

  afterEach(async () => {
    setLogger(null);
    await slack.stop();
  });

  async function mention(text: string): Promise<void> {
    await slack.deliver({
      type: 'app_mention',
      text,
      user: USER_ID,
      channel: CHANNEL_ID,
      ts: MESSAGE_TS,
      event_ts: MESSAGE_TS,
    });
  }

  it('test_handle_message_success', async () => {
    runner.events = [modelEvent('Hi user!')];

    await mention('Hello bot');

    expect(runner.runCalls).toHaveLength(1);
    expect(slack.argsFor('chat.postMessage')).toMatchObject([
      {channel: CHANNEL_ID, text: '_Thinking..._', thread_ts: MESSAGE_TS},
    ]);
    expect(slack.argsFor('chat.update')).toEqual([
      {channel: CHANNEL_ID, ts: POSTED_TS, text: 'Hi user!'},
    ]);
  });

  it('test_handle_message_multi_turn', async () => {
    runner.events = [modelEvent('First thing.'), modelEvent('Second thing.')];

    await mention('Tell me two things');

    expect(slack.argsFor('chat.update')).toEqual([
      {channel: CHANNEL_ID, ts: POSTED_TS, text: 'First thing.'},
    ]);
    expect(slack.argsFor('chat.postMessage')).toMatchObject([
      {channel: CHANNEL_ID, text: '_Thinking..._', thread_ts: MESSAGE_TS},
      {channel: CHANNEL_ID, text: 'Second thing.', thread_ts: MESSAGE_TS},
    ]);
  });

  it('test_handle_message_error', async () => {
    runner.failure = new Error('Something went wrong');

    await mention('Trigger error');

    expect(slack.argsFor('chat.postMessage')).toMatchObject([
      {channel: CHANNEL_ID, text: '_Thinking..._', thread_ts: MESSAGE_TS},
    ]);
    const updates = slack.argsFor('chat.update');
    expect(updates).toHaveLength(1);
    expect(updates[0]['text']).toContain('Sorry, I encountered an error');
  });
});
