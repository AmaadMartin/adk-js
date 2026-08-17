/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Message, TaskStatusUpdateEvent} from '@a2a-js/sdk';
import {RequestContext} from '@a2a-js/sdk/server';
import {
  A2AEvent,
  Event as AdkEvent,
  createEvent,
  ExecuteInterceptor,
  ExecutorContext,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  runAfterAgentInterceptors,
  runAfterEventInterceptors,
  runBeforeAgentInterceptors,
} from '../../src/a2a/executor_interceptor_utils.js';

function createMessage(text: string): Message {
  return {
    kind: 'message',
    messageId: `message-${text}`,
    role: 'user',
    parts: [{kind: 'text', text}],
  };
}

function createContext(text: string): RequestContext {
  return new RequestContext(createMessage(text), 'task-1', 'ctx-1');
}

function createExecutorContext(): ExecutorContext {
  return {
    appName: 'test-app',
    userId: 'test-user',
    sessionId: 'test-session',
    readonlyState: {},
    events: [],
    userContent: {role: 'user', parts: [{text: 'hello'}]},
    requestContext: createContext('hello'),
  };
}

function createAdkEvent(): AdkEvent {
  return createEvent({author: 'test-agent', invocationId: 'inv-1'});
}

function createStatusEvent(taskId: string): TaskStatusUpdateEvent {
  return {
    kind: 'status-update',
    taskId,
    contextId: 'ctx-1',
    final: false,
    status: {state: 'working'},
  };
}

const unusedBeforeAgent: NonNullable<
  ExecuteInterceptor['beforeAgent']
> = async () => expect.fail('beforeAgent must not run in the afterEvent phase');

const unusedAfterEvent: NonNullable<
  ExecuteInterceptor['afterEvent']
> = async () => expect.fail('afterEvent must not run in the beforeAgent phase');

describe('runBeforeAgentInterceptors', () => {
  it('returns the entered context when no interceptor is configured', async () => {
    const context = createContext('hello');

    await expect(runBeforeAgentInterceptors(context, undefined)).resolves.toBe(
      context,
    );
    await expect(runBeforeAgentInterceptors(context, [])).resolves.toBe(
      context,
    );
  });

  it('threads each hook return value into the next hook, in order', async () => {
    const entered = createContext('entered');
    const firstOut = createContext('first-out');
    const secondOut = createContext('second-out');
    const seen: RequestContext[] = [];

    const result = await runBeforeAgentInterceptors(entered, [
      {
        beforeAgent: async (context) => {
          seen.push(context);
          return firstOut;
        },
      },
      {
        beforeAgent: async (context) => {
          seen.push(context);
          return secondOut;
        },
      },
    ]);

    expect(seen).toEqual([entered, firstOut]);
    expect(result).toBe(secondOut);
  });

  it('skips an interceptor that has no beforeAgent hook', async () => {
    const replacement = createContext('replacement');

    const result = await runBeforeAgentInterceptors(createContext('entered'), [
      {afterEvent: unusedAfterEvent},
      {beforeAgent: async () => replacement},
    ]);

    expect(result).toBe(replacement);
  });
});

describe('runAfterEventInterceptors', () => {
  it('returns the entered event when no interceptor is configured', async () => {
    const event = createStatusEvent('task-1');
    const executorContext = createExecutorContext();
    const adkEvent = createAdkEvent();

    await expect(
      runAfterEventInterceptors(event, executorContext, adkEvent, undefined),
    ).resolves.toEqual([event]);
    await expect(
      runAfterEventInterceptors(event, executorContext, adkEvent, []),
    ).resolves.toEqual([event]);
  });

  it('replaces the event with the single event a hook returns', async () => {
    const replacement = createStatusEvent('replacement');

    const result = await runAfterEventInterceptors(
      createStatusEvent('task-1'),
      createExecutorContext(),
      createAdkEvent(),
      [{afterEvent: async () => replacement}],
    );

    expect(result).toEqual([replacement]);
  });

  it('fans the event out in order when a hook returns an array', async () => {
    const first = createStatusEvent('first');
    const second = createStatusEvent('second');

    const result = await runAfterEventInterceptors(
      createStatusEvent('task-1'),
      createExecutorContext(),
      createAdkEvent(),
      [{afterEvent: async () => [first, second]}],
    );

    expect(result).toEqual([first, second]);
  });

  it('drops the event when a hook returns undefined', async () => {
    const result = await runAfterEventInterceptors(
      createStatusEvent('task-1'),
      createExecutorContext(),
      createAdkEvent(),
      [{afterEvent: async () => undefined}],
    );

    expect(result).toEqual([]);
  });

  it('ends the chain once every event is dropped', async () => {
    const laterCalls: A2AEvent[] = [];

    const result = await runAfterEventInterceptors(
      createStatusEvent('task-1'),
      createExecutorContext(),
      createAdkEvent(),
      [
        {afterEvent: async () => undefined},
        {
          afterEvent: async (_context, a2aEvent) => {
            laterCalls.push(a2aEvent);
            return a2aEvent;
          },
        },
      ],
    );

    expect(result).toEqual([]);
    expect(laterCalls).toEqual([]);
  });

  it('runs a later hook once per fanned-out event, with the same context and ADK event', async () => {
    const first = createStatusEvent('first');
    const second = createStatusEvent('second');
    const executorContext = createExecutorContext();
    const adkEvent = createAdkEvent();
    const seen: Array<[ExecutorContext, A2AEvent, AdkEvent]> = [];

    const result = await runAfterEventInterceptors(
      createStatusEvent('task-1'),
      executorContext,
      adkEvent,
      [
        {afterEvent: async () => [first, second]},
        {
          afterEvent: async (context, a2aEvent, event) => {
            seen.push([context, a2aEvent, event]);
            return a2aEvent;
          },
        },
      ],
    );

    expect(seen.map(([, a2aEvent]) => a2aEvent)).toEqual([first, second]);
    expect(seen.every(([context]) => context === executorContext)).toBe(true);
    expect(seen.every(([, , event]) => event === adkEvent)).toBe(true);
    expect(result).toEqual([first, second]);
  });

  it('skips an interceptor that has no afterEvent hook', async () => {
    const replacement = createStatusEvent('replacement');

    const result = await runAfterEventInterceptors(
      createStatusEvent('task-1'),
      createExecutorContext(),
      createAdkEvent(),
      [{beforeAgent: unusedBeforeAgent}, {afterEvent: async () => replacement}],
    );

    expect(result).toEqual([replacement]);
  });
});

describe('runAfterAgentInterceptors', () => {
  it('returns the entered event when no interceptor is configured', async () => {
    const finalEvent = createStatusEvent('task-1');
    const executorContext = createExecutorContext();

    await expect(
      runAfterAgentInterceptors(executorContext, finalEvent, undefined),
    ).resolves.toBe(finalEvent);
    await expect(
      runAfterAgentInterceptors(executorContext, finalEvent, []),
    ).resolves.toBe(finalEvent);
  });

  it('unwinds the interceptor stack in reverse registration order', async () => {
    const entered = createStatusEvent('entered');
    const outerOut = createStatusEvent('outer');
    const innerOut = createStatusEvent('inner');
    const seen: TaskStatusUpdateEvent[] = [];

    const result = await runAfterAgentInterceptors(
      createExecutorContext(),
      entered,
      [
        {
          afterAgent: async (_context, finalEvent) => {
            seen.push(finalEvent);
            return outerOut;
          },
        },
        {
          afterAgent: async (_context, finalEvent) => {
            seen.push(finalEvent);
            return innerOut;
          },
        },
      ],
    );

    expect(seen).toEqual([entered, innerOut]);
    expect(result).toBe(outerOut);
  });

  it('skips an interceptor that has no afterAgent hook', async () => {
    const replacement = createStatusEvent('replacement');

    const result = await runAfterAgentInterceptors(
      createExecutorContext(),
      createStatusEvent('task-1'),
      [{afterAgent: async () => replacement}, {beforeAgent: unusedBeforeAgent}],
    );

    expect(result).toBe(replacement);
  });
});
