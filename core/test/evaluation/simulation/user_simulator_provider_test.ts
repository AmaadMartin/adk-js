/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseUserSimulatorConfig,
  EvalCase,
  InputValidationError,
  Invocation,
  NextUserMessage,
  NotFoundError,
  registerUserSimulator,
  UserSimulator,
  UserSimulatorProvider,
  UserSimulatorStatus,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** A simulator that answers `text` forever, standing in for a real one. */
function stubSimulator(text: string): UserSimulator {
  return {
    async getNextUserMessage(): Promise<NextUserMessage> {
      return {
        status: UserSimulatorStatus.SUCCESS,
        userMessage: {role: 'user', parts: [{text}]},
      };
    },
  };
}

function turn(text: string): Invocation {
  return {
    invocationId: `inv_${text}`,
    userContent: {role: 'user', parts: [{text}]},
  };
}

function evalCase(conversation?: Invocation[]): EvalCase {
  return {evalId: 'case_0', creationTimestamp: 0, conversation};
}

/** The first message the simulator produces, which identifies who built it. */
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

  it('prefers the static conversation over a registered config type', async () => {
    registerUserSimulator('static_loses', () =>
      stubSimulator('from the registry'),
    );
    const provider = new UserSimulatorProvider({
      userSimulatorConfig: {type: 'static_loses'},
    });

    const simulator = provider.provide(evalCase([turn('scripted')]));

    expect(await firstMessage(simulator)).toBe('scripted');
  });

  it('dispatches to the factory registered for the config type', async () => {
    const received: Array<{
      config: BaseUserSimulatorConfig;
      evalCase: EvalCase;
    }> = [];
    registerUserSimulator('recording', (params) => {
      received.push(params);
      return stubSimulator('from the registry');
    });
    const config: BaseUserSimulatorConfig = {type: 'recording'};
    const scenarioCase = evalCase();

    const simulator = new UserSimulatorProvider({
      userSimulatorConfig: config,
    }).provide(scenarioCase);

    expect(await firstMessage(simulator)).toBe('from the registry');
    expect(received).toHaveLength(1);
    expect(received[0].config).toBe(config);
    expect(received[0].evalCase).toBe(scenarioCase);
  });

  it('replaces the factory when a type is registered again', async () => {
    registerUserSimulator('replaced', () => stubSimulator('first factory'));
    registerUserSimulator('replaced', () => stubSimulator('second factory'));

    const simulator = new UserSimulatorProvider({
      userSimulatorConfig: {type: 'replaced'},
    }).provide(evalCase());

    expect(await firstMessage(simulator)).toBe('second factory');
  });

  it('reports the registered types when the config names none of them', () => {
    registerUserSimulator('listed', () => stubSimulator('listed'));
    const provider = new UserSimulatorProvider({
      userSimulatorConfig: {type: 'never_registered'},
    });

    expect(() => provider.provide(evalCase())).toThrow(NotFoundError);
    expect(() => provider.provide(evalCase())).toThrow(
      /No UserSimulator registered for config type `never_registered`\..*Currently registered: \[.*\blisted\b.*\]\./s,
    );
  });

  it('rejects a case with neither a conversation nor a config', () => {
    const provider = new UserSimulatorProvider();

    expect(() => provider.provide(evalCase())).toThrow(InputValidationError);
    expect(() => provider.provide(evalCase())).toThrow(
      'Neither static invocations nor conversation scenario provided in ' +
        'EvalCase. Provide exactly one.',
    );
  });

  it('rejects a case whose config carries no type', () => {
    const provider = new UserSimulatorProvider({userSimulatorConfig: {}});

    expect(() => provider.provide(evalCase())).toThrow(InputValidationError);
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
