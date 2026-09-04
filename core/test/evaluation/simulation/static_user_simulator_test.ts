/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  Invocation,
  StaticUserSimulator,
  UserSimulatorStatus,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function turn(text: string): Invocation {
  return {
    invocationId: `inv_${text}`,
    userContent: {role: 'user', parts: [{text}]},
  };
}

describe('StaticUserSimulator', () => {
  it('replays the scripted turns in order', async () => {
    const simulator = new StaticUserSimulator([turn('one'), turn('two')]);

    const first = await simulator.getNextUserMessage([]);
    const second = await simulator.getNextUserMessage([]);

    expect(first.status).toBe(UserSimulatorStatus.SUCCESS);
    expect(first.userMessage?.parts?.[0].text).toBe('one');
    expect(second.status).toBe(UserSimulatorStatus.SUCCESS);
    expect(second.userMessage?.parts?.[0].text).toBe('two');
  });

  it('stops without a message once the script is exhausted', async () => {
    const simulator = new StaticUserSimulator([turn('only')]);

    await simulator.getNextUserMessage([]);
    const afterEnd = await simulator.getNextUserMessage([]);
    const wellAfterEnd = await simulator.getNextUserMessage([]);

    expect(afterEnd).toEqual({
      status: UserSimulatorStatus.STOP_SIGNAL_DETECTED,
    });
    expect(wellAfterEnd).toEqual({
      status: UserSimulatorStatus.STOP_SIGNAL_DETECTED,
    });
  });

  it('stops on the first call for an empty conversation', async () => {
    const simulator = new StaticUserSimulator([]);

    expect(await simulator.getNextUserMessage([])).toEqual({
      status: UserSimulatorStatus.STOP_SIGNAL_DETECTED,
    });
  });

  it('ignores the conversation history it is given', async () => {
    const simulator = new StaticUserSimulator([turn('scripted')]);
    const history = [
      createEvent({
        author: 'agent',
        invocationId: 'inv1',
        content: {role: 'model', parts: [{text: 'anything'}]},
      }),
    ];

    const next = await simulator.getNextUserMessage(history);

    expect(next.userMessage?.parts?.[0].text).toBe('scripted');
  });
});

describe('StaticUserSimulator.getSimulationEvaluator', () => {
  it('has nothing to score, because a script cannot deviate', () => {
    const simulator = new StaticUserSimulator([turn('only')]);

    expect(simulator.getSimulationEvaluator()).toBeUndefined();
  });
});
