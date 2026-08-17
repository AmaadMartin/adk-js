/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Message, Task} from '@a2a-js/sdk';
import {DefaultRequestHandler, InMemoryTaskStore} from '@a2a-js/sdk/server';
import type {Event as AdkEvent, InvocationContext} from '@google/adk';
import {
  A2AAgentExecutor,
  BaseAgent,
  createEvent,
  getA2AAgentCard,
  InMemorySessionService,
} from '@google/adk';
import {randomUUID} from 'node:crypto';
import {describe, expect, it} from 'vitest';

/**
 * An agent that stops on `started` and resumes only when the test releases it,
 * so a cancel request lands while the run is still in flight.
 */
class BlockingAgent extends BaseAgent {
  readonly started: Promise<void>;
  readonly completed: Promise<void>;
  private signalStarted!: () => void;
  private signalCompleted!: () => void;
  private release!: () => void;
  private readonly released: Promise<void>;

  constructor() {
    super({name: 'blocking_agent', description: 'blocks until released'});
    this.started = new Promise<void>((resolve) => {
      this.signalStarted = resolve;
    });
    this.completed = new Promise<void>((resolve) => {
      this.signalCompleted = resolve;
    });
    this.released = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  finish(): void {
    this.release();
  }

  protected async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    this.signalStarted();
    await this.released;
    yield createEvent({
      author: this.name,
      invocationId: ctx.invocationId,
      content: {role: 'model', parts: [{text: 'late response'}]},
    });
    this.signalCompleted();
  }

  protected async *runLiveImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    yield* this.runAsyncImpl(ctx);
  }
}

async function createRequestHandler(
  agent: BaseAgent,
): Promise<DefaultRequestHandler> {
  const agentCard = await getA2AAgentCard(agent, [
    {url: 'http://localhost/jsonrpc', transport: 'JSONRPC'},
  ]);
  const executor = new A2AAgentExecutor({
    runner: {
      agent,
      appName: agent.name,
      sessionService: new InMemorySessionService(),
    },
  });
  return new DefaultRequestHandler(
    agentCard,
    new InMemoryTaskStore(),
    executor,
  );
}

function userMessage(): Message {
  return {
    kind: 'message',
    messageId: randomUUID(),
    role: 'user',
    parts: [{kind: 'text', text: 'work on something long'}],
  };
}

describe('A2A: task cancellation', () => {
  it('cancels an in-flight task through the A2A request handler', async () => {
    const agent = new BlockingAgent();
    const handler = await createRequestHandler(agent);

    let announceTaskId!: (id: string) => void;
    const taskIdKnown = new Promise<string>((resolve) => {
      announceTaskId = resolve;
    });

    const stream = handler.sendMessageStream({message: userMessage()});
    const drained = (async () => {
      for await (const event of stream) {
        if (event.kind === 'task') {
          announceTaskId(event.id);
        }
      }
    })();

    const taskId = await taskIdKnown;
    await agent.started;

    const canceled: Task = await handler.cancelTask({id: taskId});
    expect(canceled.id).toBe(taskId);
    expect(canceled.status.state).toBe('canceled');

    // The stream ends on the terminal canceled event even though the agent run
    // is still suspended.
    await drained;

    const stored = await handler.getTask({id: taskId});
    expect(stored.status.state).toBe('canceled');

    agent.finish();
    await agent.completed;
  });
});
