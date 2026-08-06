/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BoundSessionService,
  InMemorySessionService,
  createEvent,
  createEventActions,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/**
 * Standalone test verification function for BoundSessionService e2e workflow.
 * Executes unmocked interaction across session creation, event appending,
 * state accumulation, and session deletion.
 */
async function verifyBoundSessionServiceE2eWorkflow(): Promise<void> {
  const service = new InMemorySessionService();

  // 1. Get or bind session
  const bound: BoundSessionService = await service.getOrBindSession({
    appName: 'e2e-conversation-app',
    userId: 'user-e2e',
    sessionId: 'session-e2e-1',
    state: {turnCount: 0, status: 'started'},
  });

  expect(bound.appName).toBe('e2e-conversation-app');
  expect(bound.userId).toBe('user-e2e');
  expect(bound.sessionId).toBe('session-e2e-1');
  expect(bound.state).toEqual({turnCount: 0, status: 'started'});

  // 2. Simulate alternating user and agent events with state deltas
  const userEvent1 = createEvent({
    timestamp: 1000,
    author: 'user',
    content: {parts: [{text: 'Hello, I want to check my account balance.'}]},
    actions: createEventActions({
      stateDelta: {turnCount: 1, lastSpeaker: 'user', intent: 'check_balance'},
    }),
  });
  await bound.appendEvent(userEvent1);

  expect(bound.state).toEqual({
    turnCount: 1,
    status: 'started',
    lastSpeaker: 'user',
    intent: 'check_balance',
  });
  expect(bound.events).toHaveLength(1);

  const agentEvent1 = createEvent({
    timestamp: 2000,
    author: 'agent',
    content: {parts: [{text: 'Sure, checking balance now.'}]},
    actions: createEventActions({
      stateDelta: {turnCount: 2, lastSpeaker: 'agent', status: 'processing'},
    }),
  });
  await bound.appendEvent(agentEvent1);

  expect(bound.state).toEqual({
    turnCount: 2,
    status: 'processing',
    lastSpeaker: 'agent',
    intent: 'check_balance',
  });
  expect(bound.events).toHaveLength(2);

  const userEvent2 = createEvent({
    timestamp: 3000,
    author: 'user',
    content: {parts: [{text: 'Thanks!'}]},
    actions: createEventActions({
      stateDelta: {turnCount: 3, lastSpeaker: 'user'},
    }),
  });
  await bound.appendEvent(userEvent2);

  expect(bound.state).toEqual({
    turnCount: 3,
    status: 'processing',
    lastSpeaker: 'user',
    intent: 'check_balance',
  });
  expect(bound.events).toHaveLength(3);

  // 3. Verify state persistence by querying the service directly
  const fetchedSession = await service.getSession({
    appName: 'e2e-conversation-app',
    userId: 'user-e2e',
    sessionId: 'session-e2e-1',
  });
  expect(fetchedSession?.state).toEqual(bound.state);
  expect(fetchedSession?.events).toHaveLength(3);

  // 4. Cleanly remove session
  await bound.deleteSession();

  const verifyDeleted = await service.getSession({
    appName: 'e2e-conversation-app',
    userId: 'user-e2e',
    sessionId: 'session-e2e-1',
  });
  expect(verifyDeleted).toBeUndefined();
}

describe('BoundSessionService E2E Workflow', () => {
  it('executes full session lifecycle with zero mocks', async () => {
    await verifyBoundSessionServiceE2eWorkflow();
  });
});
