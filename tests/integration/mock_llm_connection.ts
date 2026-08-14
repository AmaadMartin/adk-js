/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BaseLlmConnection, LlmRequest, LlmResponse} from '@google/adk';
import {BaseLlm} from '@google/adk';
import type {Blob, Content} from '@google/genai';

/** Options controlling the scripted behavior of {@link MockLlmConnection}. */
export interface MockLlmConnectionOptions {
  /** Responses yielded, in order, from `receive()`. */
  responses?: LlmResponse[];
  /** When set, `receive()` throws this after yielding `responses`. */
  receiveError?: Error;
  /** When true, `receive()` blocks after its responses until `close()`. */
  blockUntilClosed?: boolean;
}

/**
 * A scriptable live connection for integration tests. Backward compatible with
 * a zero-argument constructor (yields nothing and ends immediately), while also
 * recording every outbound call for assertions.
 */
export class MockLlmConnection implements BaseLlmConnection {
  readonly sentHistory: Content[][] = [];
  readonly sentContents: Content[] = [];
  readonly sentRealtimeBlobs: Blob[] = [];
  activityStartCount = 0;
  activityEndCount = 0;
  closeCount = 0;

  private isClosed = false;
  private resolveClosed!: () => void;
  private readonly closedPromise: Promise<void>;

  constructor(private readonly options: MockLlmConnectionOptions = {}) {
    this.closedPromise = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  async sendHistory(history: Content[]): Promise<void> {
    this.sentHistory.push(history);
  }

  async sendContent(content: Content): Promise<void> {
    this.sentContents.push(content);
  }

  async sendRealtime(blob: Blob): Promise<void> {
    this.sentRealtimeBlobs.push(blob);
  }

  async sendActivityStart(): Promise<void> {
    this.activityStartCount++;
  }

  async sendActivityEnd(): Promise<void> {
    this.activityEndCount++;
  }

  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    for (const response of this.options.responses ?? []) {
      yield response;
    }
    if (this.options.receiveError) {
      throw this.options.receiveError;
    }
    if (this.options.blockUntilClosed) {
      await this.closedPromise;
    }
  }

  async close(): Promise<void> {
    if (!this.isClosed) {
      this.isClosed = true;
      this.closeCount++;
      this.resolveClosed();
    }
  }
}

/**
 * A live model whose `connect()` returns a queued sequence of connections,
 * recording the call count and the resumption handle observed each time.
 */
export class MockLiveLlm extends BaseLlm {
  connectCount = 0;
  readonly connectHandles: Array<string | undefined> = [];
  private readonly connections: MockLlmConnection[];

  constructor(connections: MockLlmConnection[]) {
    super({model: 'mock-live-llm'});
    this.connections = [...connections];
  }

  // eslint-disable-next-line require-yield
  async *generateContentAsync(): AsyncGenerator<LlmResponse, void, void> {
    throw new Error('generateContentAsync is not used by the live flow.');
  }

  async connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    this.connectCount++;
    this.connectHandles.push(
      llmRequest.liveConnectConfig.sessionResumption?.handle,
    );
    const connection = this.connections.shift();
    if (!connection) {
      throw new Error('No more mock connections queued.');
    }
    return connection;
  }
}
