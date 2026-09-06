/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, Event, InvocationContext, LlmAgent} from '@google/adk';

/** Answers without calling a model, so the test needs no credentials. */
class FixedReplyAgent extends LlmAgent {
  async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {parts: [{text: 'analytics fixture reply'}], role: 'model'},
    });
  }
}

export const rootAgent = new FixedReplyAgent({name: 'bq_agent'});
