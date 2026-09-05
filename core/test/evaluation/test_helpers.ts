/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseLlm, BaseLlmConnection, LlmResponse} from '@google/adk';

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
