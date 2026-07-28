/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Invocation, StaticUserSimulator, Status} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('StaticUserSimulator', () => {
  it('returns messages in order, then STOP_SIGNAL_DETECTED', async () => {
    const conversation: Invocation[] = [
      {invocationId: 'inv1', userContent: {parts: [{text: 'message 1'}]}},
      {invocationId: 'inv2', userContent: {parts: [{text: 'message 2'}]}},
    ];
    const simulator = new StaticUserSimulator({
      staticConversation: conversation,
    });

    const first = await simulator.getNextUserMessage([]);
    expect(first.status).toBe(Status.SUCCESS);
    expect(first.userMessage?.parts?.[0].text).toBe('message 1');

    const second = await simulator.getNextUserMessage([]);
    expect(second.status).toBe(Status.SUCCESS);
    expect(second.userMessage?.parts?.[0].text).toBe('message 2');

    const third = await simulator.getNextUserMessage([]);
    expect(third.status).toBe(Status.STOP_SIGNAL_DETECTED);
    expect(third.userMessage).toBeUndefined();
  });

  it('exposes the static conversation and has no evaluator', () => {
    const conversation: Invocation[] = [
      {invocationId: 'inv1', userContent: {parts: [{text: 'hi'}]}},
    ];
    const simulator = new StaticUserSimulator({
      staticConversation: conversation,
    });
    expect(simulator.staticConversation).toBe(conversation);
    expect(simulator.getSimulationEvaluator()).toBeUndefined();
  });
});
