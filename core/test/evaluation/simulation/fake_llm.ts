/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';

/** The model name a {@link FakeLlm} answers to. */
export const FAKE_MODEL = 'fake-user-simulator-llm';

/**
 * A model that replays a script instead of calling a service, so a simulated
 * conversation is deterministic and offline. It also records what it was
 * asked.
 */
export class FakeLlm extends BaseLlm {
  static override readonly supportedModels = [FAKE_MODEL];

  /** The requests the caller sent, in order. */
  readonly requests: LlmRequest[] = [];

  /** The responses to yield on the next call. A test fills this. */
  readonly responses: LlmResponse[] = [];

  constructor(params: {model: string} = {model: FAKE_MODEL}) {
    super(params);
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(llmRequest);
    yield* this.responses;
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error('FakeLlm does not support live connections.');
  }
}
