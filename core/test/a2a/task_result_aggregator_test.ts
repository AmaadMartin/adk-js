/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {describe, expect, it} from 'vitest';
import {MessageRole, TaskState} from '../../src/a2a/a2a_event.js';
import {
  applyAggregatedTaskState,
  TaskResultAggregator,
} from '../../src/a2a/task_result_aggregator.js';

function createTestMessage(text: string): Message {
  return {
    kind: 'message',
    messageId: 'test-msg',
    role: MessageRole.AGENT,
    parts: [{kind: 'text', text}],
  };
}

function createStatusEvent(
  state: TaskState,
  message?: Message,
  final = false,
): TaskStatusUpdateEvent {
  return {
    kind: 'status-update',
    taskId: 'test-task',
    contextId: 'test-context',
    final,
    status: {state, message},
  };
}

describe('TaskResultAggregator', () => {
  it('starts out working with no status message', () => {
    const aggregator = new TaskResultAggregator();

    expect(aggregator.taskState).toBe(TaskState.WORKING);
    expect(aggregator.taskStatusMessage).toBeUndefined();
  });

  it('records a failed event and rewrites it to working', () => {
    const aggregator = new TaskResultAggregator();
    const statusMessage = createTestMessage('Failed to process');
    const event = createStatusEvent(TaskState.FAILED, statusMessage, true);

    aggregator.processEvent(event);

    expect(aggregator.taskState).toBe(TaskState.FAILED);
    expect(aggregator.taskStatusMessage).toBe(statusMessage);
    expect(event.status.state).toBe(TaskState.WORKING);
  });

  it('records an auth-required event and rewrites it to working', () => {
    const aggregator = new TaskResultAggregator();
    const statusMessage = createTestMessage('Authentication needed');
    const event = createStatusEvent(TaskState.AUTH_REQUIRED, statusMessage);

    aggregator.processEvent(event);

    expect(aggregator.taskState).toBe(TaskState.AUTH_REQUIRED);
    expect(aggregator.taskStatusMessage).toBe(statusMessage);
    expect(event.status.state).toBe(TaskState.WORKING);
  });

  it('records an input-required event and rewrites it to working', () => {
    const aggregator = new TaskResultAggregator();
    const statusMessage = createTestMessage('Input required');
    const event = createStatusEvent(TaskState.INPUT_REQUIRED, statusMessage);

    aggregator.processEvent(event);

    expect(aggregator.taskState).toBe(TaskState.INPUT_REQUIRED);
    expect(aggregator.taskStatusMessage).toBe(statusMessage);
    expect(event.status.state).toBe(TaskState.WORKING);
  });

  it('records a failed event that carries no status message', () => {
    const aggregator = new TaskResultAggregator();

    aggregator.processEvent(
      createStatusEvent(TaskState.FAILED, undefined, true),
    );

    expect(aggregator.taskState).toBe(TaskState.FAILED);
    expect(aggregator.taskStatusMessage).toBeUndefined();
  });

  it('prefers failed over a previously recorded auth-required', () => {
    const aggregator = new TaskResultAggregator();
    const authMessage = createTestMessage('Auth required');
    aggregator.processEvent(
      createStatusEvent(TaskState.AUTH_REQUIRED, authMessage),
    );
    expect(aggregator.taskState).toBe(TaskState.AUTH_REQUIRED);
    expect(aggregator.taskStatusMessage).toBe(authMessage);

    const failedMessage = createTestMessage('Failed');
    aggregator.processEvent(
      createStatusEvent(TaskState.FAILED, failedMessage, true),
    );

    expect(aggregator.taskState).toBe(TaskState.FAILED);
    expect(aggregator.taskStatusMessage).toBe(failedMessage);
  });

  it('prefers auth-required over a previously recorded input-required', () => {
    const aggregator = new TaskResultAggregator();
    const inputMessage = createTestMessage('Input needed');
    aggregator.processEvent(
      createStatusEvent(TaskState.INPUT_REQUIRED, inputMessage),
    );
    expect(aggregator.taskState).toBe(TaskState.INPUT_REQUIRED);
    expect(aggregator.taskStatusMessage).toBe(inputMessage);

    const authMessage = createTestMessage('Auth needed');
    aggregator.processEvent(
      createStatusEvent(TaskState.AUTH_REQUIRED, authMessage),
    );

    expect(aggregator.taskState).toBe(TaskState.AUTH_REQUIRED);
    expect(aggregator.taskStatusMessage).toBe(authMessage);
  });

  it('ignores events that are not status updates, including a failed Task', () => {
    const aggregator = new TaskResultAggregator();
    const artifactEvent: TaskArtifactUpdateEvent = {
      kind: 'artifact-update',
      taskId: 'test-task',
      contextId: 'test-context',
      artifact: {
        artifactId: 'test-artifact',
        parts: [{kind: 'text', text: 'chunk'}],
      },
    };
    const task: Task = {
      kind: 'task',
      id: 'test-task',
      contextId: 'test-context',
      status: {
        state: TaskState.FAILED,
        message: createTestMessage('Task failed'),
      },
    };

    aggregator.processEvent(artifactEvent);
    aggregator.processEvent(task);

    expect(aggregator.taskState).toBe(TaskState.WORKING);
    expect(aggregator.taskStatusMessage).toBeUndefined();
    // A Task also carries `status.state`; only `kind` may discriminate.
    expect(task.status.state).toBe(TaskState.FAILED);
  });

  it('does not let a working event override a recorded failed state', () => {
    const aggregator = new TaskResultAggregator();
    const failedMessage = createTestMessage('Failure message');
    aggregator.processEvent(
      createStatusEvent(TaskState.FAILED, failedMessage, true),
    );

    aggregator.processEvent(createStatusEvent(TaskState.WORKING));

    expect(aggregator.taskState).toBe(TaskState.FAILED);
    expect(aggregator.taskStatusMessage).toBe(failedMessage);
  });

  it('moves the status message up the precedence ladder with the state', () => {
    const aggregator = new TaskResultAggregator();

    const inputMessage = createTestMessage('Input message');
    aggregator.processEvent(
      createStatusEvent(TaskState.INPUT_REQUIRED, inputMessage),
    );
    expect(aggregator.taskStatusMessage).toBe(inputMessage);

    const authMessage = createTestMessage('Auth message');
    aggregator.processEvent(
      createStatusEvent(TaskState.AUTH_REQUIRED, authMessage),
    );
    expect(aggregator.taskStatusMessage).toBe(authMessage);

    const failedMessage = createTestMessage('Failed message');
    aggregator.processEvent(
      createStatusEvent(TaskState.FAILED, failedMessage, true),
    );
    expect(aggregator.taskStatusMessage).toBe(failedMessage);

    aggregator.processEvent(
      createStatusEvent(
        TaskState.WORKING,
        createTestMessage('Working message'),
      ),
    );
    expect(aggregator.taskState).toBe(TaskState.FAILED);
    expect(aggregator.taskStatusMessage).toBe(failedMessage);
  });

  it('records the message from a working event while still working', () => {
    const aggregator = new TaskResultAggregator();
    const workingMessage = createTestMessage('Working on task');
    const event = createStatusEvent(TaskState.WORKING, workingMessage);

    aggregator.processEvent(event);

    expect(aggregator.taskState).toBe(TaskState.WORKING);
    expect(aggregator.taskStatusMessage).toBe(workingMessage);
    expect(event.status.state).toBe(TaskState.WORKING);
  });

  it('clears the status message when a working event carries none', () => {
    const aggregator = new TaskResultAggregator();

    aggregator.processEvent(createStatusEvent(TaskState.WORKING));

    expect(aggregator.taskState).toBe(TaskState.WORKING);
    expect(aggregator.taskStatusMessage).toBeUndefined();
  });

  it('does not let a working event override a recorded auth-required state', () => {
    const aggregator = new TaskResultAggregator();
    const authMessage = createTestMessage('Auth required');
    aggregator.processEvent(
      createStatusEvent(TaskState.AUTH_REQUIRED, authMessage),
    );

    aggregator.processEvent(
      createStatusEvent(
        TaskState.WORKING,
        createTestMessage('Working on auth'),
      ),
    );

    expect(aggregator.taskState).toBe(TaskState.AUTH_REQUIRED);
    expect(aggregator.taskStatusMessage).toBe(authMessage);
  });

  it('keeps failed when auth-required arrives afterwards', () => {
    const aggregator = new TaskResultAggregator();
    const failedMessage = createTestMessage('Failed first');
    aggregator.processEvent(
      createStatusEvent(TaskState.FAILED, failedMessage, true),
    );

    const authEvent = createStatusEvent(
      TaskState.AUTH_REQUIRED,
      createTestMessage('Auth later'),
    );
    aggregator.processEvent(authEvent);

    expect(aggregator.taskState).toBe(TaskState.FAILED);
    expect(aggregator.taskStatusMessage).toBe(failedMessage);
    expect(authEvent.status.state).toBe(TaskState.WORKING);
  });

  it('keeps failed when input-required arrives afterwards', () => {
    const aggregator = new TaskResultAggregator();
    const failedMessage = createTestMessage('Failed first');
    aggregator.processEvent(
      createStatusEvent(TaskState.FAILED, failedMessage, true),
    );

    aggregator.processEvent(
      createStatusEvent(
        TaskState.INPUT_REQUIRED,
        createTestMessage('Input later'),
      ),
    );

    expect(aggregator.taskState).toBe(TaskState.FAILED);
    expect(aggregator.taskStatusMessage).toBe(failedMessage);
  });

  it('keeps auth-required when input-required arrives afterwards', () => {
    const aggregator = new TaskResultAggregator();
    const authMessage = createTestMessage('Auth first');
    aggregator.processEvent(
      createStatusEvent(TaskState.AUTH_REQUIRED, authMessage),
    );

    aggregator.processEvent(
      createStatusEvent(
        TaskState.INPUT_REQUIRED,
        createTestMessage('Input later'),
      ),
    );

    expect(aggregator.taskState).toBe(TaskState.AUTH_REQUIRED);
    expect(aggregator.taskStatusMessage).toBe(authMessage);
  });

  it('rewrites a state outside the precedence table to working', () => {
    const aggregator = new TaskResultAggregator();
    const completedMessage = createTestMessage('All done');
    const event = createStatusEvent(
      TaskState.COMPLETED,
      completedMessage,
      true,
    );

    aggregator.processEvent(event);

    expect(aggregator.taskState).toBe(TaskState.WORKING);
    expect(aggregator.taskStatusMessage).toBe(completedMessage);
    expect(event.status.state).toBe(TaskState.WORKING);
  });
});

describe('applyAggregatedTaskState', () => {
  const createFallback = (): TaskStatusUpdateEvent => ({
    kind: 'status-update',
    taskId: 'fallback-task',
    contextId: 'fallback-context',
    final: true,
    status: {
      state: TaskState.COMPLETED,
      timestamp: '2026-01-01T00:00:00.000Z',
    },
    metadata: {'adk_app_name': 'test-app'},
  });

  it('returns the fallback unchanged while the aggregated state is working', () => {
    const fallback = createFallback();

    const result = applyAggregatedTaskState(
      fallback,
      new TaskResultAggregator(),
    );

    expect(result).toBe(fallback);
  });

  it('overrides the fallback state and message once a signal is aggregated', () => {
    const aggregator = new TaskResultAggregator();
    const failedMessage = createTestMessage('Boom');
    aggregator.processEvent(
      createStatusEvent(TaskState.FAILED, failedMessage, true),
    );
    const fallback = createFallback();

    const result = applyAggregatedTaskState(fallback, aggregator);

    expect(result.status.state).toBe(TaskState.FAILED);
    expect(result.status.message).toBe(failedMessage);
    expect(result.status.timestamp).toBe(fallback.status.timestamp);
    expect(result.taskId).toBe(fallback.taskId);
    expect(result.contextId).toBe(fallback.contextId);
    expect(result.final).toBe(true);
    expect(result.metadata).toEqual(fallback.metadata);
  });

  it('carries an absent status message through the override', () => {
    const aggregator = new TaskResultAggregator();
    aggregator.processEvent(
      createStatusEvent(TaskState.FAILED, undefined, true),
    );

    const result = applyAggregatedTaskState(createFallback(), aggregator);

    expect(result.status.state).toBe(TaskState.FAILED);
    expect(result.status.message).toBeUndefined();
  });
});
