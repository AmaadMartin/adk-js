/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Task, TaskStatusUpdateEvent} from '@a2a-js/sdk';
import {ExecutionEventBus, RequestContext} from '@a2a-js/sdk/server';
import {
  A2AEvent,
  createEvent,
  createEventActions,
  createSession,
  TaskState,
} from '@google/adk';
import {describe, expect, it, Mocked, vi} from 'vitest';
import {createExecutorContext} from '../../src/a2a/executor_context.js';
import {
  enqueueSubmittedSignal,
  executeAfterAgentInterceptors,
  executeAfterEventInterceptors,
  executeBeforeAgentInterceptors,
  ExecuteInterceptor,
  requireRequestContext,
} from '../../src/a2a/executor_utils.js';

const adkEvent = createEvent({
  author: 'model',
  content: {role: 'model', parts: [{text: 'hi'}]},
  actions: createEventActions(),
});

const executorContext = createExecutorContext({
  session: createSession({id: 'session-1', appName: 'app-1', userId: 'user-1'}),
  userContent: {role: 'user', parts: [{text: 'hello'}]},
  requestContext: createRequestContext(),
});

function createRequestContext(overrides = {}): RequestContext {
  return {
    contextId: 'context-1',
    taskId: 'task-1',
    userMessage: {
      kind: 'message',
      messageId: 'message-1',
      role: 'user',
      parts: [{kind: 'text', text: 'hello'}],
    },
    ...overrides,
  } as unknown as RequestContext;
}

function createEventBus(): Mocked<ExecutionEventBus> {
  return {publish: vi.fn()} as unknown as Mocked<ExecutionEventBus>;
}

function createStatusUpdate(state: TaskState): TaskStatusUpdateEvent {
  return {
    kind: 'status-update',
    taskId: 'task-1',
    contextId: 'context-1',
    final: false,
    status: {state, timestamp: '2026-01-01T00:00:00.000Z'},
  };
}

describe('requireRequestContext', () => {
  it('returns the task id and context id', () => {
    expect(requireRequestContext(createRequestContext())).toEqual({
      taskId: 'task-1',
      contextId: 'context-1',
    });
  });

  it('throws when the message is missing', () => {
    expect(() =>
      requireRequestContext(createRequestContext({userMessage: undefined})),
    ).toThrow('message not provided');
  });

  it('throws when the task id is missing', () => {
    expect(() =>
      requireRequestContext(createRequestContext({taskId: ''})),
    ).toThrow('A2A request must have a task ID');
  });

  it('throws when the context id is missing', () => {
    expect(() =>
      requireRequestContext(createRequestContext({contextId: ''})),
    ).toThrow('A2A request must have a context ID');
  });
});

describe('enqueueSubmittedSignal', () => {
  it('publishes a leading submitted task for a new task', () => {
    const eventBus = createEventBus();
    const ctx = createRequestContext();

    enqueueSubmittedSignal(ctx, eventBus);

    expect(eventBus.publish).toHaveBeenCalledTimes(1);
    const task = eventBus.publish.mock.calls[0][0] as Task;
    expect(task.kind).toBe('task');
    expect(task.id).toBe('task-1');
    expect(task.contextId).toBe('context-1');
    expect(task.status.state).toBe(TaskState.SUBMITTED);
  });

  it('publishes nothing when the task already exists', () => {
    const eventBus = createEventBus();
    const ctx = createRequestContext({
      task: {kind: 'task', id: 'task-1', contextId: 'context-1'},
    });

    enqueueSubmittedSignal(ctx, eventBus);

    expect(eventBus.publish).not.toHaveBeenCalled();
  });
});

describe('executeBeforeAgentInterceptors', () => {
  it('returns the original context when there are no interceptors', async () => {
    const ctx = createRequestContext();

    expect(await executeBeforeAgentInterceptors(ctx)).toBe(ctx);
  });

  it('chains the interceptors so the last returned context wins', async () => {
    const first = createRequestContext({taskId: 'first'});
    const second = createRequestContext({taskId: 'second'});
    const seen: string[] = [];
    const interceptors: ExecuteInterceptor[] = [
      {
        beforeAgent: async (ctx) => {
          seen.push(ctx.taskId);
          return first;
        },
      },
      {},
      {
        beforeAgent: async (ctx) => {
          seen.push(ctx.taskId);
          return second;
        },
      },
    ];

    const result = await executeBeforeAgentInterceptors(
      createRequestContext(),
      interceptors,
    );

    expect(seen).toEqual(['task-1', 'first']);
    expect(result).toBe(second);
  });
});

describe('executeAfterEventInterceptors', () => {
  it('passes the event through when there is no interceptor', async () => {
    const event = createStatusUpdate(TaskState.WORKING);

    const result = await executeAfterEventInterceptors(
      event,
      executorContext,
      adkEvent,
    );

    expect(result).toEqual([event]);
  });

  it('receives the executor context, event and ADK event', async () => {
    const event = createStatusUpdate(TaskState.WORKING);
    const afterEvent = vi.fn(async () => event);

    await executeAfterEventInterceptors(event, executorContext, adkEvent, [
      {afterEvent},
    ]);

    expect(afterEvent).toHaveBeenCalledWith(executorContext, event, adkEvent);
  });

  it('fans one event out into several, skipping an interceptor without the hook', async () => {
    const event = createStatusUpdate(TaskState.WORKING);
    const extra = createStatusUpdate(TaskState.WORKING);
    const interceptors: ExecuteInterceptor[] = [
      {},
      {afterEvent: async (_ctx, e) => [e, extra]},
    ];

    const result = await executeAfterEventInterceptors(
      event,
      executorContext,
      adkEvent,
      interceptors,
    );

    expect(result).toEqual([event, extra]);
  });

  it('drops the event and leaves later interceptors nothing to see', async () => {
    const later = vi.fn(async (): Promise<A2AEvent | undefined> => undefined);
    const interceptors: ExecuteInterceptor[] = [
      {afterEvent: async () => undefined},
      {afterEvent: later},
    ];

    const result = await executeAfterEventInterceptors(
      createStatusUpdate(TaskState.WORKING),
      executorContext,
      adkEvent,
      interceptors,
    );

    expect(result).toEqual([]);
    expect(later).not.toHaveBeenCalled();
  });
});

describe('executeAfterAgentInterceptors', () => {
  it('returns the event unchanged when there is no interceptor', async () => {
    const event = createStatusUpdate(TaskState.COMPLETED);

    expect(await executeAfterAgentInterceptors(executorContext, event)).toBe(
      event,
    );
  });

  it('runs the interceptors in reverse order', async () => {
    const order: string[] = [];
    const rewritten = createStatusUpdate(TaskState.FAILED);
    const interceptors: ExecuteInterceptor[] = [
      {
        afterAgent: async () => {
          order.push('first');
          return rewritten;
        },
      },
      {},
      {
        afterAgent: async (_ctx, event) => {
          order.push('last');
          return event;
        },
      },
    ];

    const result = await executeAfterAgentInterceptors(
      executorContext,
      createStatusUpdate(TaskState.COMPLETED),
      interceptors,
    );

    expect(order).toEqual(['last', 'first']);
    expect(result).toBe(rewritten);
  });
});
