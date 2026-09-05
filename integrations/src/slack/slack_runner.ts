/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getLogger, loadOptionalPeer, Runner} from '@google/adk';
import {createUserContent} from '@google/genai';
import type {App, SayFn, SocketModeReceiver} from '@slack/bolt';

/** Placeholder posted while the agent is still producing its answer. */
const THINKING_TEXT = '_Thinking..._';

/** Prefix of the message shown to the user when the run throws. */
const ERROR_PREFIX = 'Sorry, I encountered an error: ';

/**
 * The fields `app_mention` and the handled `message` subtypes have in common.
 *
 * Bolt models `message` as a union whose members carry different subsets of
 * these, so the handler takes the intersection it reads rather than one
 * concrete member. The snake_case names are Slack wire fields and are kept
 * verbatim.
 */
export interface SlackMessageEvent {
  text?: string;
  user?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  bot_profile?: unknown;
  channel_type?: string;
}

/** Options for constructing a {@link SlackRunner}. */
export interface SlackRunnerOptions {
  /** The ADK runner that executes the agent. */
  runner: Runner;
  /** A configured Bolt app. Its bot token must already be set. */
  slackApp: App;
}

/** Everything {@link handleSlackMessage} needs to answer one Slack event. */
export interface HandleSlackMessageParams {
  /** The ADK runner that executes the agent. */
  runner: Runner;
  /** The Slack web client used to edit and delete the placeholder. */
  client: App['client'];
  /** The incoming `app_mention` or `message` event. */
  event: SlackMessageEvent;
  /** Bolt's `say`, which posts a new message in the same conversation. */
  say: SayFn;
}

/**
 * Runs an ADK agent's reply for one Slack message or app mention.
 *
 * The reply starts as a `_Thinking..._` placeholder. The first text part the
 * run produces replaces that placeholder; every later text part is posted as a
 * new message in the same thread. A run that produces no text at all deletes
 * the placeholder instead of leaving it behind.
 *
 * Module-level rather than a method, because it needs no instance state:
 * {@link SlackRunner} hands it everything it reads.
 *
 * @param params The runner, Slack client, event and `say` for this message.
 */
export async function handleSlackMessage(
  params: HandleSlackMessageParams,
): Promise<void> {
  const {runner, client, event, say} = params;
  const text = event.text;
  const userId = event.user;
  const channel = event.channel;
  // `||`, not `??`: the reference uses `or`, so an empty thread_ts falls
  // back to ts rather than keying a session on the empty string.
  const threadTs = event.thread_ts || event.ts;

  if (!text || !userId || !channel) return;

  const sessionId = threadTs ? `${channel}-${threadTs}` : channel;

  let thinkingTs: string | undefined;
  try {
    thinkingTs = (await say({text: THINKING_TEXT, thread_ts: threadTs})).ts;

    for await (const runEvent of runner.runAsync({
      userId,
      sessionId,
      newMessage: createUserContent(text),
    })) {
      for (const part of runEvent.content?.parts ?? []) {
        if (!part.text) continue;
        if (thinkingTs) {
          await client.chat.update({channel, ts: thinkingTs, text: part.text});
          thinkingTs = undefined;
        } else {
          await say({text: part.text, thread_ts: threadTs});
        }
      }
    }

    if (thinkingTs) {
      await client.chat.delete({channel, ts: thinkingTs});
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const errorMessage = `${ERROR_PREFIX}${message}`;
    getLogger().error('Error running ADK agent for Slack:', err);
    if (thinkingTs) {
      await client.chat.update({channel, ts: thinkingTs, text: errorMessage});
    } else {
      await say({text: errorMessage, thread_ts: threadTs});
    }
  }
}

/**
 * Runs ADK agents on Slack over Socket Mode.
 *
 * Constructing the runner registers two listeners on the supplied Bolt app:
 * `app_mention`, which is always answered, and `message`, which is answered
 * only for a direct message or a threaded reply. Messages a bot posted are
 * ignored so the agent cannot answer itself.
 *
 * One Slack thread maps onto one ADK session, keyed `<channel>-<threadTs>`.
 * The caller creates that session; `Runner.runAsync` throws when it is absent.
 *
 * @example
 * ```ts
 * const slackRunner = new SlackRunner({
 *   runner,
 *   slackApp: new App({token: process.env.SLACK_BOT_TOKEN}),
 * });
 * await slackRunner.start(process.env.SLACK_APP_TOKEN!);
 * ```
 */
export class SlackRunner {
  /** The ADK runner that executes the agent. */
  readonly runner: Runner;

  /** The Bolt app this runner listens on. */
  readonly slackApp: App;

  private receiver?: SocketModeReceiver;

  constructor(options: SlackRunnerOptions) {
    this.runner = options.runner;
    this.slackApp = options.slackApp;
    this.setupHandlers();
  }

  /** Registers the `app_mention` and `message` listeners on the Bolt app. */
  private setupHandlers(): void {
    this.slackApp.event('app_mention', async ({event, say}) => {
      await this.handle(event, say);
    });

    this.slackApp.event('message', async ({event, say}) => {
      const message: SlackMessageEvent = event;
      if (message.bot_id || message.bot_profile) return;
      const isIm = message.channel_type === 'im';
      const inThread = message.thread_ts !== undefined;
      if (!isIm && !inThread) return;
      await this.handle(message, say);
    });
  }

  private handle(event: SlackMessageEvent, say: SayFn): Promise<void> {
    return handleSlackMessage({
      runner: this.runner,
      client: this.slackApp.client,
      event,
      say,
    });
  }

  /**
   * Opens the Socket Mode connection.
   *
   * @param appToken An app-level token (`xapp-…`) with `connections:write`.
   * @throws If the runner is already started, or if the optional peer
   *   dependency `@slack/bolt` is not installed.
   */
  async start(appToken: string): Promise<void> {
    if (this.receiver) {
      throw new Error('SlackRunner is already started.');
    }
    const {SocketModeReceiver} = await loadOptionalPeer(
      {packageName: '@slack/bolt', feature: 'SlackRunner'},
      () => import('@slack/bolt'),
    );
    const receiver = new SocketModeReceiver({appToken});
    receiver.init(this.slackApp);
    this.receiver = receiver;
    await receiver.start();
  }

  /** Closes the Socket Mode connection. Does nothing if it is not open. */
  async stop(): Promise<void> {
    const receiver = this.receiver;
    if (!receiver) return;
    this.receiver = undefined;
    await receiver.stop();
  }
}
