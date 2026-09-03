/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Message, Task} from '@a2a-js/sdk';
import {
  AgentExecutionEvent,
  DefaultExecutionEventBus,
  ExecutionEventBus,
  RequestContext,
  ServerCallContext,
  User,
} from '@a2a-js/sdk/server';
import {Mock, vi} from 'vitest';

const DEFAULT_USER_MESSAGE: Message = {
  kind: 'message',
  messageId: 'message-1',
  role: 'user',
  parts: [{kind: 'text', text: 'hello'}],
};

/**
 * The parts of a request an A2A executor test varies.
 *
 * Pass `userMessage: undefined` explicitly to build the message-less request
 * the executor is expected to reject.
 */
export interface RequestContextOverrides {
  taskId?: string;
  contextId?: string;
  userMessage?: Message;
  task?: Task;
  context?: ServerCallContext;
}

/**
 * Builds a real `RequestContext` for a test.
 */
export function createRequestContext(
  overrides: RequestContextOverrides = {},
): RequestContext {
  const {
    taskId = 'test-task',
    contextId = 'test-context',
    task,
    context,
  } = overrides;
  const userMessage =
    'userMessage' in overrides ? overrides.userMessage : DEFAULT_USER_MESSAGE;

  return new RequestContext(
    // `RequestContext` types the message as always present, but a real server
    // can deliver a request without one and the executor has to reject it.
    userMessage as Message,
    taskId,
    contextId,
    task,
    undefined,
    context,
  );
}

/**
 * Builds the call context an authenticated A2A server attaches to a request.
 */
export function createCallContext(user?: User): ServerCallContext {
  return new ServerCallContext(undefined, user);
}

/** A real event bus whose `publish` calls a test can inspect. */
export type SpiedEventBus = ExecutionEventBus & {
  publish: Mock<(event: AgentExecutionEvent) => void>;
};

/**
 * Builds a real event bus that records what an executor publishes on it.
 */
export function createEventBus(): SpiedEventBus {
  const eventBus = new DefaultExecutionEventBus();

  return Object.assign(eventBus, {
    publish: vi.fn(eventBus.publish.bind(eventBus)),
  });
}
