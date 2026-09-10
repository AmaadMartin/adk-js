/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getLogger, Runner} from '@google/adk';
import {createUserContent} from '@google/genai';
import type {App, SayFn, types} from '@slack/bolt';

const THINKING_TEXT = '_Thinking..._';
const ERROR_PREFIX = 'Sorry, I encountered an error: ';

/** The two Slack event shapes {@link SlackRunner} answers. */
export type SlackAgentEvent = types.AppMentionEvent | types.GenericMessageEvent;

/** Reports whether a `message` event is one the agent should answer. */
function shouldAnswerMessage(event: types.GenericMessageEvent): boolean {
  if (event.bot_id || event.bot_profile) {
    return false;
  }
  return event.channel_type === 'im' || event.thread_ts !== undefined;
}

/** Configuration for {@link SlackRunner}. */
export interface SlackRunnerConfig {
  /** The ADK runner that executes the agent. */
  runner: Runner;
  /**
   * The Slack Bolt app to answer events on. For Socket Mode, construct it with
   * `new App({token, socketMode: true, appToken})`; Bolt for JavaScript takes
   * the app-level token there, so {@link SlackRunner.start} needs no argument.
   */
  slackApp: App;
}

/**
 * Runs an ADK agent on Slack.
 *
 * The runner answers `app_mention` events, and the `message` events a bot
 * should reply to: direct messages and threaded replies, never a bot's own
 * output. It maps one Slack thread onto one ADK session, keyed
 * `<channel>-<threadTs>`, so the agent keeps the thread's context.
 *
 * @example
 * ```typescript
 * const slackApp = new App({
 *   token: process.env.SLACK_BOT_TOKEN,
 *   socketMode: true,
 *   appToken: process.env.SLACK_APP_TOKEN,
 * });
 * await new SlackRunner({runner, slackApp}).start();
 * ```
 */
export class SlackRunner {
  private readonly runner: Runner;
  private readonly slackApp: App;
  private started = false;

  constructor(config: SlackRunnerConfig) {
    this.runner = config.runner;
    this.slackApp = config.slackApp;
    this.setupHandlers();
  }

  /**
   * Connects the Slack app.
   *
   * @throws If the runner was already started. Bolt's Socket Mode client
   *     overwrites its own connection handle on a second `start()`, which
   *     orphans the first connection.
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error('SlackRunner is already started.');
    }
    this.started = true;
    await this.slackApp.start();
  }

  private setupHandlers(): void {
    this.slackApp.event('app_mention', async ({event, say}) => {
      await this.handleMessage(event, say);
    });
    this.slackApp.event('message', async ({event, say}) => {
      if (event.subtype === undefined && shouldAnswerMessage(event)) {
        await this.handleMessage(event, say);
      }
    });
  }

  private async handleMessage(
    event: SlackAgentEvent,
    say: SayFn,
  ): Promise<void> {
    const {text, user: userId, channel} = event;
    const threadTs = event.thread_ts ?? event.ts;
    if (!text || !userId) {
      return;
    }

    const sessionId = `${channel}-${threadTs}`;
    let thinkingTs: string | undefined;
    try {
      thinkingTs = (await say({text: THINKING_TEXT, thread_ts: threadTs})).ts;
      await this.runner.sessionService.getOrCreateSession({
        appName: this.runner.appName,
        userId,
        sessionId,
      });
      for await (const runEvent of this.runner.runAsync({
        userId,
        sessionId,
        newMessage: createUserContent(text),
      })) {
        for (const part of runEvent.content?.parts ?? []) {
          if (!part.text) {
            continue;
          }
          if (thinkingTs) {
            await this.slackApp.client.chat.update({
              channel,
              ts: thinkingTs,
              text: part.text,
            });
            thinkingTs = undefined;
          } else {
            await say({text: part.text, thread_ts: threadTs});
          }
        }
      }
      if (thinkingTs) {
        await this.slackApp.client.chat.delete({channel, ts: thinkingTs});
      }
    } catch (error: unknown) {
      const errorText =
        ERROR_PREFIX + (error instanceof Error ? error.message : String(error));
      getLogger().error('Error running ADK agent for Slack:', error);
      if (thinkingTs) {
        await this.slackApp.client.chat.update({
          channel,
          ts: thinkingTs,
          text: errorText,
        });
      } else {
        await say({text: errorText, thread_ts: threadTs});
      }
    }
  }
}
