/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AsyncQueue,
  BaseLlm,
  BaseLlmConnection,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {Blob, Content} from '@google/genai';

/** A live connection that replays a script and records what was sent to it. */
export class ScriptedLiveConnection implements BaseLlmConnection {
  readonly historyCalls: Content[][] = [];
  readonly contentCalls: Content[] = [];
  readonly realtimeCalls: Blob[] = [];
  closed = false;
  private readonly queue = new AsyncQueue<LlmResponse>();

  constructor(responses: LlmResponse[]) {
    for (const response of responses) {
      this.queue.push(response);
    }
  }

  async sendHistory(history: Content[]): Promise<void> {
    this.historyCalls.push(history);
  }

  async sendContent(content: Content): Promise<void> {
    this.contentCalls.push(content);
  }

  async sendRealtime(blob: Blob): Promise<void> {
    this.realtimeCalls.push(blob);
  }

  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    yield* this.queue;
  }

  /** Ends the script, which ends the flow's receive loop. */
  endTurnStream(): void {
    this.queue.close();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.queue.close();
  }
}

/**
 * A live model that hands out one {@link ScriptedLiveConnection} per
 * `connect()` call, taking the next script in the list.
 */
export class ScriptedLiveLlm extends BaseLlm {
  readonly connections: ScriptedLiveConnection[] = [];
  readonly requestsSeen: LlmRequest[] = [];

  constructor(
    private readonly scripts: LlmResponse[][],
    model = 'scripted-live-llm',
  ) {
    super({model});
  }

  // eslint-disable-next-line require-yield -- the live tests never call it.
  override async *generateContentAsync(): AsyncGenerator<
    LlmResponse,
    void,
    void
  > {
    throw new Error('generateContentAsync is not used by the live tests.');
  }

  override async connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    // The flow mutates liveConnectConfig between attempts, so snapshot it.
    this.requestsSeen.push(
      JSON.parse(JSON.stringify(llmRequest)) as LlmRequest,
    );
    const connection = new ScriptedLiveConnection(
      this.scripts[this.connections.length] ?? [],
    );
    this.connections.push(connection);
    return connection;
  }
}
