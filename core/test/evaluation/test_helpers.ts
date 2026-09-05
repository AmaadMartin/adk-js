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
 * A live connection the test feeds by hand, so a live eval run is offline and
 * the moment each response arrives is under the test's control.
 */
export class FakeLiveConnection implements BaseLlmConnection {
  readonly contentCalls: Content[] = [];
  closed = false;
  private readonly responses = new AsyncQueue<LlmResponse | Error>();

  /**
   * @param ignoreClose Whether `close` leaves the response stream open, so the
   *     reader parks instead of finishing. Used to drive a shutdown timeout.
   */
  constructor(private readonly ignoreClose = false) {}

  /** Delivers responses to the reader, in order. */
  emit(...responses: Array<LlmResponse | Error>): void {
    for (const response of responses) {
      this.responses.push(response);
    }
  }

  /** Ends the response stream, as a model that hung up would. */
  endStream(): void {
    this.responses.close();
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

/**
 * A model serving one {@link FakeLiveConnection} on the live path.
 *
 * The connection exists before the run starts, so a test can queue responses
 * up front or release them turn by turn.
 */
export class FakeLiveLlm extends BaseLlm {
  readonly connection: FakeLiveConnection;

  /**
   * @param ignoreClose Whether the connection leaves its stream open on close.
   */
  constructor(ignoreClose = false) {
    super({model: 'fake-live-llm'});
    this.connection = new FakeLiveConnection(ignoreClose);
  }

  generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    throw new Error('FakeLiveLlm only serves the live path.');
  }

  async connect(): Promise<BaseLlmConnection> {
    return this.connection;
  }
}
