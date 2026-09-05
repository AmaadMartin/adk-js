/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ported from adk-python
// tests/unittests/integrations/slack/test_slack_runner.py @ main.

import {handleSlackMessage} from '@google/adk-integrations';
import {beforeEach, describe, expect, it} from 'vitest';
import {
  CHANNEL,
  createSlackFixture,
  EVENT_TS,
  modelEvent,
  streamOf,
  THINKING_TS,
  USER,
} from './slack_fixture.js';

describe('SlackRunner', () => {
  let fixture: ReturnType<typeof createSlackFixture>;

  beforeEach(() => {
    fixture = createSlackFixture();
  });

  const event = (text: string) => ({
    text,
    user: USER,
    channel: CHANNEL,
    ts: EVENT_TS,
  });

  it('test_handle_message_success', async () => {
    const {runner, client, say, update, remove, runAsync} = fixture;
    runAsync.mockImplementation(streamOf([modelEvent('Hi user!')]));

    await handleSlackMessage({runner, client, event: event('Hello bot'), say});

    expect(runAsync).toHaveBeenCalledOnce();
    expect(say).toHaveBeenCalledOnce();
    expect(say).toHaveBeenCalledWith({
      text: '_Thinking..._',
      thread_ts: EVENT_TS,
    });
    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith({
      channel: CHANNEL,
      ts: THINKING_TS,
      text: 'Hi user!',
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it('test_handle_message_multi_turn', async () => {
    const {runner, client, say, update, runAsync} = fixture;
    runAsync.mockImplementation(
      streamOf([modelEvent('First thing.'), modelEvent('Second thing.')]),
    );

    await handleSlackMessage({
      runner,
      client,
      event: event('Tell me two things'),
      say,
    });

    // The first part replaces the placeholder; the second is a new message.
    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith({
      channel: CHANNEL,
      ts: THINKING_TS,
      text: 'First thing.',
    });
    expect(say).toHaveBeenCalledTimes(2);
    expect(say).toHaveBeenCalledWith({
      text: '_Thinking..._',
      thread_ts: EVENT_TS,
    });
    expect(say).toHaveBeenCalledWith({
      text: 'Second thing.',
      thread_ts: EVENT_TS,
    });
  });

  it('test_handle_message_error', async () => {
    const {runner, client, say, update, runAsync} = fixture;
    runAsync.mockImplementation(streamOf(new Error('Something went wrong')));

    await handleSlackMessage({
      runner,
      client,
      event: event('Trigger error'),
      say,
    });

    expect(say).toHaveBeenCalledOnce();
    expect(say).toHaveBeenCalledWith({
      text: '_Thinking..._',
      thread_ts: EVENT_TS,
    });
    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Sorry, I encountered an error'),
      }),
    );
  });
});
