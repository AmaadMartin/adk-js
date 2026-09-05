/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalCase,
  InputValidationError,
  Invocation,
  UserSimulator,
  UserSimulatorProvider,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function turn(text: string): Invocation {
  return {
    invocationId: `inv_${text}`,
    userContent: {role: 'user', parts: [{text}]},
  };
}

function evalCase(conversation?: Invocation[]): EvalCase {
  return {evalId: 'case_0', creationTimestamp: 0, conversation};
}

/** The first message the simulator produces. */
async function firstMessage(simulator: UserSimulator): Promise<string> {
  const next = await simulator.getNextUserMessage([]);
  return next.userMessage?.parts?.[0].text ?? '';
}

describe('UserSimulatorProvider', () => {
  it('replays a static conversation', async () => {
    const provider = new UserSimulatorProvider();

    const simulator = provider.provide(evalCase([turn('scripted')]));

    expect(await firstMessage(simulator)).toBe('scripted');
  });

  it('accepts an empty conversation rather than rejecting it', async () => {
    const provider = new UserSimulatorProvider();

    const simulator = provider.provide(evalCase([]));

    expect(await firstMessage(simulator)).toBe('');
  });

  it('rejects a case that carries no conversation', () => {
    const provider = new UserSimulatorProvider();

    expect(() => provider.provide(evalCase())).toThrow(InputValidationError);
    expect(() => provider.provide(evalCase())).toThrow(
      'Neither static invocations nor conversation scenario provided in ' +
        'EvalCase. Provide exactly one.',
    );
  });

  it('builds a fresh simulator on every call for the same case', async () => {
    const provider = new UserSimulatorProvider();
    const sharedCase = evalCase([turn('only')]);

    const first = provider.provide(sharedCase);
    await first.getNextUserMessage([]);
    const second = provider.provide(sharedCase);

    expect(second).not.toBe(first);
    expect(await firstMessage(second)).toBe('only');
  });
});
