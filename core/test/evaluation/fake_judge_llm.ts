/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseLlm, BaseLlmConnection, LlmRequest, LlmResponse} from '@google/adk';

/** One answer a {@link FakeJudgeLlm} gives, in call order. */
export type JudgeReply =
  /** The judge answers with this critique text. */
  | {critique: string}
  /** The judge call fails with this message. */
  | {failure: string}
  /** The judge returns without answering at all. */
  | {silent: true};

/** The model name a {@link FakeJudgeLlm} reports. */
export const FAKE_JUDGE_MODEL = 'fake-judge';

/**
 * A judge model that replays a script instead of calling a service, so an eval
 * run is deterministic and offline. It also records what the metric asked it,
 * and how many calls the metric ran at once.
 */
export class FakeJudgeLlm extends BaseLlm {
  /** The requests the metric sent, in the order the judge received them. */
  readonly requests: LlmRequest[] = [];

  /** The largest number of calls that were in flight at the same time. */
  maxCallsInFlight = 0;

  private callsInFlight = 0;

  /**
   * @param replies The answers to give, one per call. The script repeats when
   *   the metric asks for more answers than it holds.
   */
  constructor(private readonly replies: readonly JudgeReply[]) {
    super({model: FAKE_JUDGE_MODEL});
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    const reply = this.replies[this.requests.length % this.replies.length];
    this.requests.push(llmRequest);
    this.callsInFlight++;
    this.maxCallsInFlight = Math.max(this.maxCallsInFlight, this.callsInFlight);
    try {
      // Suspend once, so a caller that runs several calls at a time overlaps
      // them here rather than finishing each one before it starts the next.
      await Promise.resolve();
      if ('failure' in reply) {
        throw new Error(reply.failure);
      }
      if ('critique' in reply) {
        yield {content: {role: 'model', parts: [{text: reply.critique}]}};
      }
    } finally {
      this.callsInFlight--;
    }
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error('FakeJudgeLlm does not support live connections.');
  }
}
