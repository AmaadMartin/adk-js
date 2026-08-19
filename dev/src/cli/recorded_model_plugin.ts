/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BasePlugin, Context, LlmRequest, LlmResponse} from '@google/adk';

/**
 * Answers every model call of a replayed conversation from the responses its
 * fixture recorded, so `adk test` needs no model credentials and reaches no
 * network.
 *
 * `beforeModelCallback` returning a response short-circuits the real call, so
 * a plugin covers every agent of the run — including agents that are workflow
 * graph nodes, which a walk over `subAgents` would miss.
 */
export class RecordedModelPlugin extends BasePlugin {
  private index = 0;

  constructor(
    private readonly responses: readonly LlmResponse[],
    private readonly fixtureName: string,
  ) {
    super('adk-test-recorded-model');
  }

  override async beforeModelCallback(_params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    if (this.index >= this.responses.length) {
      throw new Error(
        `${this.fixtureName}: the agent asked the model for response ` +
          `${this.index + 1} but only ${this.responses.length} were recorded.`,
      );
    }
    return this.responses[this.index++];
  }
}
