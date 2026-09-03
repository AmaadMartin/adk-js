/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Task, TaskStatusUpdateEvent, TextPart} from '@a2a-js/sdk';
import {InMemoryTaskStore} from '@a2a-js/sdk/server';
import {
  A2AAgentExecutor,
  AdkDefaultRequestHandler,
  BaseAgent,
  createEvent,
  createEventActions,
  Event,
  getA2AAgentCard,
  InMemorySessionService,
  InvocationContext,
  Session,
  toA2a,
} from '@google/adk';
import type {AddressInfo} from 'node:net';
import {describe, expect, it} from 'vitest';

/** How many events the agent emits when nothing cancels it. */
const TOTAL_EVENTS = 20;

/**
 * An agent that emits its events one at a time, so a cancellation can land
 * while it is still running.
 */
class SlowAgent extends BaseAgent {
  emitted = 0;

  /** Resolves when the run ends, whether it finished or was stopped. */
  readonly finished: Promise<void>;
  private resolveFinished: () => void = () => {};

  constructor() {
    super({name: 'slow-agent'});
    this.finished = new Promise<void>((resolve) => {
      this.resolveFinished = resolve;
    });
  }

  protected async *runAsyncImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    try {
      for (let index = 0; index < TOTAL_EVENTS; index++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        this.emitted++;
        yield createEvent({
          author: this.name,
          content: {role: 'model', parts: [{text: `chunk ${index}`}]},
          actions: createEventActions(),
        });
      }
    } finally {
      this.resolveFinished();
    }
  }

  protected async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.runAsyncImpl(context);
  }
}

/** A session service whose backing store is unavailable. */
class FailingSessionService extends InMemorySessionService {
  override async getSession(): Promise<Session | undefined> {
    throw new Error('session store down');
  }
}

interface JsonRpcResponse {
  result?: Task;
  error?: {message: string};
}

/** One A2A event as it arrives on the server-sent event stream. */
interface StreamedEvent {
  kind: string;
  id?: string;
  taskId?: string;
  final?: boolean;
  status?: TaskStatusUpdateEvent['status'];
}

const jsonRpc = async (
  port: number,
  method: string,
  params: unknown,
): Promise<JsonRpcResponse> => {
  const res = await fetch(`http://127.0.0.1:${port}/jsonrpc`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}),
  });

  return (await res.json()) as JsonRpcResponse;
};

/** Yields the A2A events carried by a JSON-RPC server-sent event stream. */
async function* streamedEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamedEvent, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) {
        return;
      }
      buffer += decoder.decode(value, {stream: true});

      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice('data: '.length);
        if (data) {
          yield (JSON.parse(data) as {result: StreamedEvent}).result;
        }
      }
    }
  } finally {
    await reader.cancel();
  }
}

describe('A2A executor behind the SDK request handler', () => {
  it('returns a failed task when the session store is down', async () => {
    const agent = new SlowAgent();
    const handler = new AdkDefaultRequestHandler(
      await getA2AAgentCard(agent, [
        {url: 'http://127.0.0.1/jsonrpc', transport: 'JSONRPC'},
      ]),
      new InMemoryTaskStore(),
      new A2AAgentExecutor({
        runner: {
          appName: 'test-app',
          agent,
          sessionService: new FailingSessionService(),
        },
      }),
    );

    // The result manager discards a status update for a task it has not seen,
    // so a failure before the submitted signal would leave the caller with an
    // internal error and no task at all.
    const result = await handler.sendMessage({
      message: {
        kind: 'message',
        messageId: 'failing-message',
        role: 'user',
        parts: [{kind: 'text', text: 'hello'}],
      },
    });

    expect(result.kind).toBe('task');
    const task = result as Task;
    expect(task.status.state).toBe('failed');
    expect((task.status.message?.parts[0] as TextPart).text).toContain(
      'session store down',
    );
  });

  it('settles a canceled task and stops the run', async () => {
    const agent = new SlowAgent();
    const app = await toA2a(agent, {allowUnauthenticated: true});
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/jsonrpc`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/stream',
          params: {
            message: {
              messageId: 'cancellation-message',
              role: 'user',
              parts: [{kind: 'text', text: 'take your time'}],
            },
          },
        }),
      });
      expect(res.body).not.toBeNull();
      if (!res.body) {
        expect.fail('the streaming response carried no body');
      }

      const kinds: string[] = [];
      let taskId: string | undefined;
      let canceling: Promise<JsonRpcResponse> | undefined;
      let terminal: StreamedEvent | undefined;

      for await (const event of streamedEvents(res.body)) {
        kinds.push(event.kind);
        taskId ??= event.id;

        // Cancel once the run is under way, so the executor holds it in flight.
        if (event.kind === 'artifact-update' && !canceling && taskId) {
          canceling = jsonRpc(port, 'tasks/cancel', {id: taskId});
        }
        if (event.final) {
          terminal = event;
          break;
        }
      }

      expect(kinds[0]).toBe('task');
      expect(terminal?.status?.state).toBe('canceled');

      await agent.finished;
      expect(agent.emitted).toBeLessThan(TOTAL_EVENTS);

      expect((await canceling)?.error).toBeUndefined();
      const fetched = await jsonRpc(port, 'tasks/get', {id: taskId});
      expect(fetched.result?.status.state).toBe('canceled');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
