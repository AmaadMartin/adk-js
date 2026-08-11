/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent, createEvent, Event} from '@google/adk';

class OtelRunAgent extends BaseAgent {
  constructor() {
    super({name: 'otel_run_agent'});
  }

  async *runAsyncImpl(): AsyncGenerator<Event, void, void> {
    yield createEvent({
      author: this.name,
      content: {role: 'model', parts: [{text: 'pong'}]},
    });
  }

  protected runLiveImpl(): AsyncGenerator<Event, void, void> {
    throw new Error('Not supported');
  }
}

export const rootAgent = new OtelRunAgent();
