/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Message,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {TaskResultAggregator, TaskState} from '@google/adk';
import {describe, expect, it} from 'vitest';

function createMessage(text: string): Message {
  return {
    kind: 'message',
    messageId: `message-${text}`,
    role: 'agent',
    parts: [{kind: 'text', text}],
  };
}

function createStatusUpdate(
  state: TaskState,
  message?: Message,
): TaskStatusUpdateEvent {
  return {
    kind: 'status-update',
    taskId: 'task-1',
    contextId: 'context-1',
    final: true,
    status: {state, message, timestamp: '2026-01-01T00:00:00.000Z'},
  };
}

describe('TaskResultAggregator', () => {
  it('starts working with no status message', () => {
    const aggregator = new TaskResultAggregator();

    expect(aggregator.taskState).toBe(TaskState.WORKING);
    expect(aggregator.taskStatusMessage).toBeUndefined();
  });

  it.each([
    TaskState.FAILED,
    TaskState.AUTH_REQUIRED,
    TaskState.INPUT_REQUIRED,
  ])('records %s and its status message', (state) => {
    const aggregator = new TaskResultAggregator();
    const message = createMessage(state);

    aggregator.processEvent(createStatusUpdate(state, message));

    expect(aggregator.taskState).toBe(state);
    expect(aggregator.taskStatusMessage).toBe(message);
  });

  it('records a settling state that carries no message', () => {
    const aggregator = new TaskResultAggregator();

    aggregator.processEvent(createStatusUpdate(TaskState.FAILED));

    expect(aggregator.taskState).toBe(TaskState.FAILED);
    expect(aggregator.taskStatusMessage).toBeUndefined();
  });

  it('lets failed override auth-required', () => {
    const aggregator = new TaskResultAggregator();
    const authMessage = createMessage('auth');
    const failedMessage = createMessage('failed');

    aggregator.processEvent(
      createStatusUpdate(TaskState.AUTH_REQUIRED, authMessage),
    );
    aggregator.processEvent(
      createStatusUpdate(TaskState.FAILED, failedMessage),
    );

    expect(aggregator.taskState).toBe(TaskState.FAILED);
    expect(aggregator.taskStatusMessage).toBe(failedMessage);
  });

  it('lets auth-required override input-required', () => {
    const aggregator = new TaskResultAggregator();
    const inputMessage = createMessage('input');
    const authMessage = createMessage('auth');

    aggregator.processEvent(
      createStatusUpdate(TaskState.INPUT_REQUIRED, inputMessage),
    );
    aggregator.processEvent(
      createStatusUpdate(TaskState.AUTH_REQUIRED, authMessage),
    );

    expect(aggregator.taskState).toBe(TaskState.AUTH_REQUIRED);
    expect(aggregator.taskStatusMessage).toBe(authMessage);
  });

  it('keeps failed when a lower state arrives afterwards', () => {
    const aggregator = new TaskResultAggregator();
    const failedMessage = createMessage('failed');

    aggregator.processEvent(
      createStatusUpdate(TaskState.FAILED, failedMessage),
    );
    aggregator.processEvent(
      createStatusUpdate(TaskState.AUTH_REQUIRED, createMessage('auth')),
    );
    aggregator.processEvent(
      createStatusUpdate(TaskState.INPUT_REQUIRED, createMessage('input')),
    );

    expect(aggregator.taskState).toBe(TaskState.FAILED);
    expect(aggregator.taskStatusMessage).toBe(failedMessage);
  });

  it('replaces the message of a repeated settling state', () => {
    const aggregator = new TaskResultAggregator();
    const second = createMessage('second');

    aggregator.processEvent(
      createStatusUpdate(TaskState.INPUT_REQUIRED, createMessage('first')),
    );
    aggregator.processEvent(
      createStatusUpdate(TaskState.INPUT_REQUIRED, second),
    );

    expect(aggregator.taskState).toBe(TaskState.INPUT_REQUIRED);
    expect(aggregator.taskStatusMessage).toBe(second);
  });

  it('keeps the latest message while nothing has settled the task', () => {
    const aggregator = new TaskResultAggregator();
    const latest = createMessage('latest');

    aggregator.processEvent(
      createStatusUpdate(TaskState.WORKING, createMessage('earlier')),
    );
    aggregator.processEvent(createStatusUpdate(TaskState.WORKING, latest));

    expect(aggregator.taskState).toBe(TaskState.WORKING);
    expect(aggregator.taskStatusMessage).toBe(latest);
  });

  it('does not let a later working event clobber a settled message', () => {
    const aggregator = new TaskResultAggregator();
    const failedMessage = createMessage('failed');

    aggregator.processEvent(
      createStatusUpdate(TaskState.FAILED, failedMessage),
    );
    aggregator.processEvent(
      createStatusUpdate(TaskState.WORKING, createMessage('later')),
    );

    expect(aggregator.taskState).toBe(TaskState.FAILED);
    expect(aggregator.taskStatusMessage).toBe(failedMessage);
  });

  it('records a completed event as a message update only', () => {
    const aggregator = new TaskResultAggregator();
    const completedMessage = createMessage('completed');

    aggregator.processEvent(
      createStatusUpdate(TaskState.COMPLETED, completedMessage),
    );

    expect(aggregator.taskState).toBe(TaskState.WORKING);
    expect(aggregator.taskStatusMessage).toBe(completedMessage);
  });

  it('rewrites every processed status update to a non-final working update', () => {
    const aggregator = new TaskResultAggregator();
    const event = createStatusUpdate(TaskState.FAILED, createMessage('failed'));

    aggregator.processEvent(event);

    expect(event.status.state).toBe(TaskState.WORKING);
    expect(event.final).toBe(false);
  });

  it('ignores an artifact update', () => {
    const aggregator = new TaskResultAggregator();
    const event: TaskArtifactUpdateEvent = {
      kind: 'artifact-update',
      taskId: 'task-1',
      contextId: 'context-1',
      lastChunk: true,
      artifact: {artifactId: 'artifact-1', parts: [{kind: 'text', text: 'hi'}]},
    };

    aggregator.processEvent(event);

    expect(aggregator.taskState).toBe(TaskState.WORKING);
    expect(aggregator.taskStatusMessage).toBeUndefined();
  });

  it('ignores a message', () => {
    const aggregator = new TaskResultAggregator();

    aggregator.processEvent(createMessage('standalone'));

    expect(aggregator.taskState).toBe(TaskState.WORKING);
    expect(aggregator.taskStatusMessage).toBeUndefined();
  });
});
