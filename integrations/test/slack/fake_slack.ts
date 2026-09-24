/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Logger, Receiver, ReceiverEvent} from '@slack/bolt';
import {App, LogLevel} from '@slack/bolt';
import {createServer, IncomingMessage, Server, ServerResponse} from 'node:http';
import {AddressInfo} from 'node:net';

/** The `ts` the fake server gives every message it accepts. */
export const POSTED_TS = 'thinking_ts';

/** One Slack Web API call the fake workspace received. */
export interface SlackApiCall {
  /** The API method, such as `chat.postMessage`. */
  method: string;
  /** The arguments the client sent. */
  args: Record<string, unknown>;
}

/** A Bolt logger that writes nothing, so a tested failure path stays quiet. */
class QuietLogger implements Logger {
  private level: LogLevel = LogLevel.ERROR;

  debug(): void {}

  info(): void {}

  warn(): void {}

  error(): void {}

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  setName(): void {}
}

/** A Bolt receiver that never opens a socket. Tests deliver events directly. */
class DirectReceiver implements Receiver {
  /** How many times the app connected through this receiver. */
  starts = 0;

  init(): void {}

  async start(): Promise<void> {
    this.starts++;
  }

  async stop(): Promise<void> {}
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    request.on('end', () => {
      resolve(body);
    });
    request.on('error', reject);
  });
}

function parseArgs(contentType: string, body: string): Record<string, unknown> {
  if (contentType.includes('application/json')) {
    return JSON.parse(body) as Record<string, unknown>;
  }
  return Object.fromEntries(new URLSearchParams(body));
}

/**
 * A Slack workspace that answers Web API calls locally and records them.
 *
 * The Bolt app it builds is a real {@link App}: it holds a real `WebClient`
 * pointed at this server, and it dispatches events through Bolt's own
 * middleware chain, so the `say` function the runner receives is Bolt's.
 */
export class FakeSlack {
  /** Every Web API call the workspace received, in order. */
  readonly calls: SlackApiCall[] = [];
  /** Methods that must answer `{ok: false}` with the mapped error string. */
  readonly failures = new Map<string, string>();
  private readonly receiver = new DirectReceiver();
  private readonly server: Server;
  private app?: App;

  private constructor(server: Server) {
    this.server = server;
  }

  /** Starts the workspace on a free port. */
  static async start(): Promise<FakeSlack> {
    const workspace = new FakeSlack(createServer());
    workspace.server.on(
      'request',
      (request: IncomingMessage, response: ServerResponse) => {
        void workspace.handle(request, response);
      },
    );
    await new Promise<void>((resolve) => {
      workspace.server.listen(0, '127.0.0.1', resolve);
    });
    return workspace;
  }

  /** The Bolt app under test, built on the first call. */
  get boltApp(): App {
    if (!this.app) {
      const {port} = this.server.address() as AddressInfo;
      this.app = new App({
        token: 'fake-bot-token',
        botId: 'B00000000',
        botUserId: 'U00000000',
        tokenVerificationEnabled: false,
        receiver: this.receiver,
        logger: new QuietLogger(),
        clientOptions: {
          slackApiUrl: `http://127.0.0.1:${port}/`,
          retryConfig: {retries: 0},
        },
      });
    }
    return this.app;
  }

  /** How many times the app connected. */
  get connectCount(): number {
    return this.receiver.starts;
  }

  /** The arguments of every recorded call to one API method. */
  argsFor(method: string): Array<Record<string, unknown>> {
    return this.calls
      .filter((call) => call.method === method)
      .map((call) => call.args);
  }

  /** Delivers one Slack event to the app, as a receiver would. */
  async deliver(event: Record<string, unknown>): Promise<void> {
    const receiverEvent: ReceiverEvent = {
      body: {
        token: 'verification-token',
        team_id: 'T00000000',
        api_app_id: 'A00000000',
        type: 'event_callback',
        event_id: `Ev${this.calls.length}`,
        event_time: 1234567890,
        event,
      },
      ack: async () => {},
    };
    await this.boltApp.processEvent(receiverEvent);
  }

  /** Stops the workspace. */
  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const method = (request.url ?? '/').replace(/^\//, '').split('?')[0];
    const body = await readBody(request);
    this.calls.push({
      method,
      args: parseArgs(request.headers['content-type'] ?? '', body),
    });
    const failure = this.failures.get(method);
    response.writeHead(200, {'content-type': 'application/json'});
    response.end(
      JSON.stringify(
        failure
          ? {ok: false, error: failure}
          : {ok: true, channel: 'C67890', ts: POSTED_TS},
      ),
    );
  }
}
