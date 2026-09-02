/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AsyncQueue, BaseLlm, BaseLlmConnection, LlmResponse} from '@google/adk';
import {Content} from '@google/genai';

/**
 * A model that replays a fixed script instead of calling a service, so an eval
 * run is deterministic and offline.
 */
export class ScriptedLlm extends BaseLlm {
  private turn = 0;

  constructor(private readonly replies: string[]) {
    super({model: 'scripted-llm'});
  }

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    const reply = this.replies[this.turn % this.replies.length];
    this.turn++;
    yield {content: {role: 'model', parts: [{text: reply}]}};
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error('ScriptedLlm does not support live connections.');
  }
}

/**
 * A live connection that replays a fixed script and records what was sent to
 * it, so a live eval run is deterministic and offline.
 */
export class ScriptedLiveConnection implements BaseLlmConnection {
  readonly contentCalls: Content[] = [];
  closed = false;
  private readonly responses = new AsyncQueue<LlmResponse | Error>();

  /**
   * @param script The responses to replay. An `Error` is thrown to the reader
   *     in its turn, standing in for a dropped connection.
   * @param ignoreClose Whether `close` leaves the response stream open, so the
   *     reader parks instead of finishing. Used to drive a shutdown timeout.
   */
  constructor(
    script: Array<LlmResponse | Error>,
    private readonly ignoreClose = false,
  ) {
    for (const response of script) {
      this.responses.push(response);
    }
  }

  async sendHistory(): Promise<void> {}

  async sendContent(content: Content): Promise<void> {
    this.contentCalls.push(content);
  }

  async sendRealtime(): Promise<void> {}

  async sendActivityStart(): Promise<void> {}

  async sendActivityEnd(): Promise<void> {}

  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    for await (const response of this.responses) {
      if (response instanceof Error) {
        throw response;
      }
      yield response;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (!this.ignoreClose) {
      this.responses.close();
    }
  }
}

/** A model that serves {@link ScriptedLiveConnection} on the live path. */
export class ScriptedLiveLlm extends BaseLlm {
  readonly connections: ScriptedLiveConnection[] = [];

  /**
   * @param script The responses every connection replays.
   * @param ignoreClose Whether a connection leaves its stream open on close.
   */
  constructor(
    private readonly script: Array<LlmResponse | Error>,
    private readonly ignoreClose = false,
  ) {
    super({model: 'scripted-live-llm'});
  }

  // eslint-disable-next-line require-yield -- the async path is never taken.
  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    throw new Error('ScriptedLiveLlm only serves the live path.');
  }

  async connect(): Promise<BaseLlmConnection> {
    const connection = new ScriptedLiveConnection(
      this.script,
      this.ignoreClose,
    );
    this.connections.push(connection);
    return connection;
  }
}
