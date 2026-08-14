/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {TaskArtifactUpdateEvent} from '@a2a-js/sdk';
import {
  AgentExecutionEvent,
  DefaultExecutionEventBus,
  RequestContext,
} from '@a2a-js/sdk/server';
import {
  A2AAgentExecutor,
  BaseAgent,
  createEvent,
  Event,
  InMemorySessionService,
  InvocationContext,
  resetIdProvider,
  setIdProvider,
} from '@google/adk';
import {afterEach, describe, expect, it} from 'vitest';

/** An agent that emits one complete (non-partial) response event. */
class SingleEventAgent extends BaseAgent {
  protected async *runAsyncImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      author: this.name,
      content: {role: 'model', parts: [{text: 'response'}]},
    });
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // The executor only drives the async path.
  }
}

function isArtifactUpdate(
  event: AgentExecutionEvent,
): event is TaskArtifactUpdateEvent {
  return event.kind === 'artifact-update';
}

describe('A2AAgentExecutor with an installed ID provider', () => {
  afterEach(() => {
    resetIdProvider();
  });

  it('mints the artifactId from the provider when no partial id is cached', async () => {
    setIdProvider(() => 'provider-id');
    const executor = new A2AAgentExecutor({
      runner: {
        appName: 'test-app',
        agent: new SingleEventAgent({name: 'test_agent'}),
        sessionService: new InMemorySessionService(),
      },
    });
    const eventBus = new DefaultExecutionEventBus();
    const published: AgentExecutionEvent[] = [];
    eventBus.on('event', (event) => published.push(event));
    const requestContext = new RequestContext(
      {
        kind: 'message',
        messageId: 'm1',
        role: 'user',
        parts: [{kind: 'text', text: 'hello'}],
      },
      'test-task',
      'test-context',
    );

    await executor.execute(requestContext, eventBus);

    const artifactUpdate = published.find(isArtifactUpdate);
    expect(artifactUpdate?.artifact.artifactId).toBe('provider-id');
  });
});
