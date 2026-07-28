/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {EvalCase, Invocation} from '../../../src/evaluation/eval_case.js';
import {StaticUserSimulator} from '../../../src/evaluation/simulation/static_user_simulator.js';
import {
  Status,
  UserSimulator,
} from '../../../src/evaluation/simulation/user_simulator.js';
import {UserSimulatorProvider} from '../../../src/evaluation/simulation/user_simulator_provider.js';

function makeInvocation(text: string): Invocation {
  return {
    invocationId: '',
    userContent: {parts: [{text}]},
    creationTimestamp: 0,
  };
}

describe('StaticUserSimulator', () => {
  it('replays the static conversation, then signals stop', async () => {
    const conversation = [makeInvocation('m1'), makeInvocation('m2')];
    const simulator = new StaticUserSimulator(conversation);

    const first = await simulator.getNextUserMessage([]);
    expect(first.status).toBe(Status.SUCCESS);
    expect(first.userMessage).toBe(conversation[0].userContent);

    const second = await simulator.getNextUserMessage([]);
    expect(second.status).toBe(Status.SUCCESS);
    expect(second.userMessage).toBe(conversation[1].userContent);

    const third = await simulator.getNextUserMessage([]);
    expect(third.status).toBe(Status.STOP_SIGNAL_DETECTED);
    expect(third.userMessage).toBeUndefined();
  });

  it('is a UserSimulator', () => {
    expect(new StaticUserSimulator([])).toBeInstanceOf(UserSimulator);
  });
});

describe('UserSimulatorProvider', () => {
  it('provides a StaticUserSimulator for a static conversation', async () => {
    const provider = new UserSimulatorProvider();
    const evalCase = {
      evalId: 'case1',
      conversation: [makeInvocation('m1')],
    } as unknown as EvalCase;

    const simulator = provider.provide(evalCase);

    expect(simulator).toBeInstanceOf(StaticUserSimulator);
    const next = await simulator.getNextUserMessage([]);
    expect(next.status).toBe(Status.SUCCESS);
    expect(next.userMessage?.parts?.[0].text).toBe('m1');
  });

  it('throws for an eval case without a static conversation', () => {
    const provider = new UserSimulatorProvider();
    const evalCase = {
      evalId: 'case1',
      conversation: undefined,
      conversationScenario: {startingPrompt: 'x', conversationPlan: 'y'},
    } as unknown as EvalCase;

    expect(() => provider.provide(evalCase)).toThrow(/not yet supported/i);
  });
});
