/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {InvocationContext} from '../../src/agents/invocation_context.js';
import {LiveRequestQueue} from '../../src/agents/live_request_queue.js';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {createEvent, Event} from '../../src/events/event.js';
import {createIc, driveNode} from './test_helpers.js';

/** Records which of the agent's two run paths the node runner picked. */
class ModeSpyAgent extends LlmAgent {
  readonly paths: string[] = [];

  protected override async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    this.paths.push('async');
    yield this.reply(ctx);
  }

  protected override async *runLiveImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    this.paths.push('live');
    yield this.reply(ctx);
  }

  private reply(ctx: InvocationContext): Event {
    return createEvent({
      author: this.name,
      invocationId: ctx.invocationId,
      content: {role: 'model', parts: [{text: 'done'}]},
    });
  }
}

/** An invocation context that carries a live connection's request queue. */
function createLiveIc(): InvocationContext {
  return createIc().clone({liveRequestQueue: new LiveRequestQueue()});
}

describe('an LlmAgent node under a live invocation', () => {
  it('runs the live flow when the invocation carries a live queue', async () => {
    const agent = new ModeSpyAgent({name: 'chat_agent'});

    await driveNode(agent, 'hello', createLiveIc());

    expect(agent.paths).toEqual(['live']);
  });

  it('runs a task-mode agent live too', async () => {
    const agent = new ModeSpyAgent({name: 'task_agent', mode: 'task'});

    await driveNode(agent, 'hello', createLiveIc());

    expect(agent.paths).toEqual(['live']);
  });

  it('keeps a single_turn agent off the live flow', async () => {
    const agent = new ModeSpyAgent({
      name: 'single_turn_agent',
      mode: 'single_turn',
    });

    await driveNode(agent, 'hello', createLiveIc());

    // A `single_turn` node consumes only its node input, so it has nothing to
    // read from the connection.
    expect(agent.paths).toEqual(['async']);
  });

  it('keeps an agent off the live flow without a live queue', async () => {
    const agent = new ModeSpyAgent({name: 'chat_agent'});

    await driveNode(agent, 'hello');

    expect(agent.paths).toEqual(['async']);
  });
});
